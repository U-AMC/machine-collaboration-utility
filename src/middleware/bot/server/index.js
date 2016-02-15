const router = require(`koa-router`)();
const Promise = require(`bluebird`);
const LineByLineReader = Promise.promisifyAll(require(`line-by-line`));
const StateMachine = Promise.promisifyAll(require(`javascript-state-machine`));
const fs = require(`fs`);
const usb = Promise.promisifyAll(require(`usb`));
const SerialPort = require(`serialport`);
const _ = require(`underscore`);

const SerialCommandExecutor = require('./serialCommandExecutor');
const FakeMarlin = require(`./fakeMarlin`);
const config = require(`../../config`);
const botRoutes = require(`./routes`);
const CommandQueue = require(`./commandQueue3`);

/**
 * This is a Bot class representing hardware that can process jobs.
 * All commands to the bot are passed to it's queue and processed sequentially
 *
 * The bot's state machine abstracts any job states (i.e. pause/resume/cancel)
 * to be handled by the Job API. In other words, in order to pause/resume/cancel a bot,
 * you must send that command to the job. This will pass down events accordingly to the bot
 *
 */
class Bot {
  /**
   * A bot server class
   * @param {Object} app - The parent Koa app.
   * @param {string} routeEndpoint - The relative endpoint.
   */
  constructor(app, routeEndpoint) {
    app.context.bot = this; // External app reference variable

    this.app = app;
    this.logger = app.context.logger;
    this.routeEndpoint = routeEndpoint;
    this.router = router;

    this.virtual = false;
    this.fakePort = new FakeMarlin(app);
    this.queue = undefined;

    // File reading assets
    this.currentJob = undefined;
    this.lr = undefined; // buffered file line reader
    this.currentLine = undefined;

    this.fsm = StateMachine.create({
      initial: 'unavailable',
      error: (one, two) => {
        const errorMessage = `Invalid state change action "${one}". State at "${two}".`;
        this.logger.error(errorMessage);
        throw errorMessage;
      },
      events: [
        /* eslint-disable no-multi-spaces */
        { name: 'detect',             from: 'unavailable',     to: 'detecting'       },
        { name: 'detectFail',         from: 'detecting',       to: 'unavailable'     },
        { name: 'detectDone',         from: 'detecting',       to: 'ready'           },
        { name: 'connect',            from: 'ready',           to: 'connecting'      },
        { name: 'connectFail',        from: 'connecting',      to: 'ready'           },
        { name: 'connectDone',        from: 'connecting',      to: 'connected'       },
        { name: 'start',              from: 'connected',       to: 'startingJob'     },
        { name: 'startFail',          from: 'startingJob',     to: 'connected'       },
        { name: 'startDone',          from: 'startingJob',     to: 'processingJob'   },
        { name: 'stop',               from: 'processingJob',   to: 'stopping'        },
        { name: 'stopDone',           from: 'stopping',        to: 'connected'       },
        { name: 'stopFail',           from: 'stopping',        to: 'connected'       },
        { name: 'jobToGcode',         from: 'processingJob',   to: 'processingGcode' },
        { name: 'jobGcodeFail',       from: 'processingGcode', to: 'processingJob'   },
        { name: 'jobGcodeDone',       from: 'processingGcode', to: 'processingJob'   },
        { name: 'connectedToGcode',   from: 'connected',       to: 'processingGcode' },
        { name: 'connectedGcodeFail', from: 'processingGcode', to: 'connected'       },
        { name: 'connectedGcodeDone', from: 'processingGcode', to: 'connected'       },
        { name: 'disconnect',         from: 'connected',       to: 'disconnecting'   },
        { name: 'disconnectFail',     from: 'disconnecting',   to: 'connected'       },
        { name: 'disconnectDone',     from: 'disconnecting',   to: 'ready'           },
        { name: 'unplug',             from: '*',               to: 'unavailable'     },
        /* eslint-enable no-multi-spaces */
      ],
      callbacks: {
        onenterstate: (event, from, to) => {
          this.app.io.emit(`stateChange`, to);
          this.logger.info(`Bot event ${event}: Transitioning from ${from} to ${to}.`);
        },
      },
    });
  }

  /**
   * initialize the jobs endpoint
   */
  async initialize() {
    try {
      await this.setupRouter();
      await this.setupUsbScanner();
      this.logger.info(`Bot instance initialized`);
    } catch (ex) {
      this.logger.error(`Bot initialization error`, ex);
    }
  }

  /*
   * get a json friendly description of the Bot
   */
  getBot() {
    return {
      state: this.fsm.current,
    };
  }

  /*
   * This is the logic for parsing any commands sent to the Bot API
   * In all cases, the API does not wait for the command to be completed, instead
   * the bot enters the appropriate transitional state, followed by either
   * "done" or "fail" events and corresponding state transitions
   */
  async processCommand(command) {
    switch (command) {
      // Create a virtual bot
      // If the virtual bot is already created, just return the bot object
      case `createVirtualBot`:
        if (!this.virtual) {
          this.virtual = true;
          this.detect();
        }
        return this.getBot();

      // Destroy a virtual bot
      // If the virtual bot doesn't exist, just return the bot object
      case `destroyVirtualBot`:
        if (this.virtual) {
          await this.unplug();
          this.virtual = false;
        }
        return this.getBot();

      // Connect the bot via it's queue's executor
      case `connect`:
        this.connect();
        return this.getBot();

      // Disconnect the bot via it's queue's executor
      case `disconnect`:
        this.disconnect();
        return this.getBot();

      // Throw out any bogus command requests
      default:
        const errorMessage = `Command "${command}" is not supported.`;
        throw errorMessage;
    }
  }

  // In order to start processing a job, the job's file is opened and then
  // processed one line at a time
  async startJob(job) {
    const self = this;

    self.currentJob = job;
    await self.fsm.start();
    const filesApp = self.app.context.files;
    const theFile = filesApp.getFile(job.fileId);
    const filePath = filesApp.getFilePath(theFile);
    self.lr = new LineByLineReader(filePath);
    self.currentLine = 0;
    await self.lr.pause(); // redundant
    // open the file
    // start reading line by line...

    self.lr.on('error', (err) => {
      self.logger.error('line reader error:', err);
    });

    // As the buffer reads each line, process it
    self.lr.on('line', async (line) => {
      // pause the line reader immediately
      // we will resume it as soon as the line is done processing
      await self.lr.pause();
      self.currentLine += 1;

      // We only care about the info prior to the first semicolon
      const strippedLine = line.split(';')[0];

      if (strippedLine.length <= 0) {
        // If the line is blank, move on to the next line
        await self.lr.resume();
      } else {
        console.log('a line!', strippedLine);
        await Promise.delay(100);
        self.queue.queueCommands(strippedLine);
        // await self.fakePort.write(strippedLine);
        if (self.currentJob.fsm.current === `running`) {
          await self.lr.resume();
        }
      }
    });

    self.lr.on('end', async () => {
      await self.fsm.stop();
      await self.lr.close();
      self.logger.info('completed reading file,', filePath, 'is closed now.');
      await self.fsm.stopDone();
      await self.currentJob.fsm.complete();
      await self.currentJob.stopwatch.stop();
    });

    // Get the number of lines in the file
    let numLines = 0;
    const fsPromise = new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
      .on('data', function readStreamOnData(chunk) {
        numLines += chunk
        .toString('utf8')
        .split(/\r\n|[\n\r\u0085\u2028\u2029]/g)
        .length - 1;
      })
      .on('end', () => {  // done
        self.numLines = numLines;
        self.logger.info(`Bot will process file with ${self.numLines} lines.`);
        resolve();
      });
    });

    await fsPromise;
    await self.lr.resume();
    await self.fsm.startDone();
  }

  async pauseJob() {
    if (this.fsm.current !== `connected`) {
      await this.fsm.stop();
      await this.lr.pause();
      await this.fsm.stopDone();
    }
  }

  async resumeJob() {
    if (this.fsm.current !== `processingJob`) {
      await this.fsm.start();
      await this.lr.resume();
      await this.fsm.startDone();
    }
  }

  async stopJob() {
    if (this.fsm.current !== `connected`) {
      await this.fsm.stop();
      await this.lr.close();
      this.lr = undefined;
      await this.fsm.stopDone();
    }
  }


  /**
   * Set up the bot's instance's router
   */
  async setupRouter() {
    try {
      // Populate this.router with all routes
      // Then register all routes with the app
      await botRoutes(this);

      // Register all router routes with the app
      this.app.use(this.router.routes()).use(this.router.allowedMethods());
      this.logger.info(`Bot router setup complete`);
    } catch (ex) {
      this.logger.error(`Bot router setup error`, ex);
    }
  }

  async detect(device) {
    this.fsm.detect();
    try {
      if (this.virtual) {
        // spoofed usb data for a virtual device
        this.device = {
          busNumber: 20,
          deviceAddress: 19,
          deviceDescriptor: {
            bLength: 18,
            bDescriptorType: 1,
            bcdUSB: 512,
            bDeviceClass: 2,
            bDeviceSubClass: 0,
            bDeviceProtocol: 0,
            bMaxPacketSize0: 32,
            idVendor: 5824,
            idProduct: 1155,
            bcdDevice: 256,
            iManufacturer: 1,
            iProduct: 2,
            iSerialNumber: 3,
            bNumConfigurations: 1,
          },
          portNumbers: [5],
        };
      } else {
        this.queue = new CommandQueue(
          this.setupExecutor(this.port, config.bot.baudrate),
          this.expandCode,
          this.validateReply
        );
      }
      this.fsm.detectDone();
    } catch (ex) {
      this.fsm.detectFail();
    }
  }

  async unplug() {
    this.device = undefined;
    await this.fsm.unplug();
  }

  async connect() {
    try {
      this.fsm.connect();
      if (this.virtual) {
        await Promise.delay(config.virtualDelay);
        await this.fsm.connectDone();
      } else {
        // TODO write connection logic here
        this.queue.queueCommands({
          open: true,
        });
        await this.fsm.connectDone();
      }
    } catch (ex) {
      this.fsm.connectFail();
    }
  }

  async disconnect() {
    try {
      this.fsm.disconnect();
      if (this.virtual) {
        await Promise.delay(config.virtualDelay);
        await this.fsm.disconnectDone();
      } else {
        // TODO write disconnect logic here
        await Promise.delay(config.virtualDelay);
        await this.fsm.disconnectDone();
      }
    } catch (ex) {
      this.fsm.disconnectFail();
    }
  }

  async setupUsbScanner() {
    const self = this;
    usb.on('attach', async (device) => {
      if (self.verifyVidPid(device) && await self.getPort()) {
        self.detect(device);
      }
    });
    usb.on('detach', (device) => {
      if (self.verifyVidPid(device)) {
        self.unplug(device);
      }
    });
    const devices = await usb.getDeviceList();
    devices.forEach(async (device) => {
      if (self.verifyVidPid(device) && await self.getPort()) {
        self.detect(device);
      }
    });
  }

  // Compare a port's vid pid with our bot's vid pid
  verifyVidPid(device) {
    if (
      device.deviceDescriptor.idVendor === config.bot.vid &&
      device.deviceDescriptor.idProduct === config.bot.pid
    ) {
      this.device = device;
      return true;
    }
    return false;
  }

  async getPort() {
    const self = this;
    const portPromise = new Promise((resolve, reject) => {
      // Don't scan the ports if we haven't set a device
      if (self.device === undefined) {
        return reject(false);
      }

      SerialPort.list((err, ports) => {
        for (let i = 0; i < ports.length; i++) {
          const port = ports[i];
          if (
            self.device.deviceDescriptor.idVendor === parseInt(port.vendorId.split('x').pop(), 16) &&
            self.device.deviceDescriptor.idProduct === parseInt(port.productId.split('x').pop(), 16)
          ) {
            self.port = port.comName;
            return resolve(true);
          }
        }
        return reject(false);
      });
    });
    return await portPromise;
  }

  setupExecutor(port, baudrate) {
    const openPrime = 'M501';
    return new SerialCommandExecutor(
      port,
      baudrate,
      openPrime
    );
  }

  /**
   * expandCode()
   *
   * Expand simple commands to gcode we can send to the bot
   *
   * Args:   code - a simple string gcode command
   * Return: a gcode string suitable for the hardware
   */
  expandCode(code) {
    // TODO consider adding checksumming
    return `${code}\n`;
  }

  /**
   * validateReply()
   *
   * Confirms if a reply contains 'ok' as its last line.  Parses out DOS newlines.
   *
   * Args:   reply - The reply from a bot after sending a command
   * Return: true if the last line was 'ok'
   */
  validateReply(command, reply) {
    const lines = reply.toString().split('\n');
    return (_.last(lines) === 'ok');
  }
}

module.exports = Bot;
