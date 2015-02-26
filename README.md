# reichat-server
The real-time paint chat server for **[reichat](https://github.com/kanreisa/reichat)**.

[![npm version][npm-img]][npm-url]
[![Linux Build][travis-img]][travis-url]
[![Windows Build][appveyor-img]][appveyor-url]
[![Dependency Status][dep-img]][dep-url]
[![devDependency Status][devdep-img]][devdep-url]

## Build

```bash
$ npm install
$ npm run tsd reinstall
$ npm run tsd rebundle
$ npm run build
```

## Example

```js
var util = require('util');
var path = require('path');
var os = require('os');
var reichatServer = require('reichat-server');

// All settings are optional.
var config = {
	title: 'PaintChat',
	canvasWidth: 1920,
	canvasHeight: 1080,
	layerCount: 3,// recommended up to 3.

	// HTTP server for distributing chat client app.
	clientDir: [__dirname, 'www'].join(path.sep),
	clientVersion: '0.0.0',

	// File System options.
	dataDir: os.tmpDir,// if supplied, chat session will persist.
	dataFilePrefix: 'reichat_exampleroom_001_',

	// Redis options. ()
	redisHost: 'localhost',// if supplied, activate Redis communication. (will disable saving to File System)
	redisPort: 6379,
	redisPassword: '',
	redisKeyPrefix: 'reichat:exampleroom#001:',// for shared Redis.

	// for security
	forwardedHeaderType: 'XFF'// use in trusted proxy
};

reichatServer.createServer(config).once('ready', function () {
	
	process.title = 'reichat server - ' + this.id;
	
	this.listen(10133, '0.0.0.0', null, function () {
		util.log(util.format('listening on %s:%s', '0.0.0.0', '10133'));
	});

	util.log(util.format('created server id: %s', this.id));
});
```

## License

[MIT](LICENSE)

![Logo](https://yabumi.cc/14b08e54b51e2abe7c7a55c7.svg)

[npm-img]: https://img.shields.io/npm/v/reichat-server.svg
[npm-url]: https://npmjs.org/package/reichat-server
[travis-img]: https://img.shields.io/travis/kanreisa/reichat-server.svg
[travis-url]: https://travis-ci.org/kanreisa/reichat-server
[appveyor-img]: https://img.shields.io/appveyor/ci/kanreisa/reichat-server.svg
[appveyor-url]: https://ci.appveyor.com/project/kanreisa/reichat-server
[dep-img]: https://david-dm.org/kanreisa/reichat-server.svg
[dep-url]: https://david-dm.org/kanreisa/reichat-server
[devdep-img]: https://david-dm.org/kanreisa/reichat-server/dev-status.svg
[devdep-url]: https://david-dm.org/kanreisa/reichat-server#info=devDependencies
