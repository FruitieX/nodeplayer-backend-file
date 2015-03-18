var path = require('path');
var nodeplayerConfig = require('nodeplayer-config');

var defaultConfig = {};

defaultConfig.mongo = 'mongodb://localhost:27017/nodeplayer-backend-file';
defaultConfig.rescanAtStart = false,
defaultConfig.importPath = nodeplayerConfig.getHomeDir() + path.sep + 'music';
defaultConfig.importFormats = [
    "mp3",
    "flac",
    "ogg",
    "opus"
];
defaultConfig.concurrentProbes = 4;
defaultConfig.followSymlinks = true;

module.exports = defaultConfig;
