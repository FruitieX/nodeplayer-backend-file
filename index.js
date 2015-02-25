"use strict";

var walk = require('walk');
var probe = require('node-ffprobe');
var path = require('path');
var mkdirp = require('mkdirp');
var url = require('url');
var fs = require('fs');
var async = require('async');
var ffmpeg = require('fluent-ffmpeg');
var watch = require('node-watch');
var _ = require('underscore');

var fileBackend = {};
fileBackend.name = 'file';

var fileConfig, config, logger, player, walker, db, medialibraryPath;

// TODO: seeking
var encodeSong = function(origStream, seek, songID, progCallback, errCallback) {
    var incompletePath = config.songCachePath + '/file/incomplete/' + songID + '.opus';
    var incompleteStream = fs.createWriteStream(incompletePath, {flags: 'w'});
    var encodedPath = config.songCachePath + '/file/' + songID + '.opus';

    var command = ffmpeg(origStream)
        .noVideo()
        //.inputFormat('mp3')
        //.inputOption('-ac 2')
        .audioCodec('libopus')
        .audioBitrate('192')
        .format('opus')
        .on('error', function(err) {
            logger.error('file: error while transcoding ' + songID + ': ' + err);
            if(fs.existsSync(incompletePath))
                fs.unlinkSync(incompletePath);
            errCallback(err);
        })

    var opusStream = command.pipe(null, {end: true});
    opusStream.on('data', function(chunk) {
        incompleteStream.write(chunk, undefined, function() {
            progCallback(chunk.length, false);
        });
    });
    opusStream.on('end', function() {
        incompleteStream.end(undefined, undefined, function() {
            logger.verbose('transcoding ended for ' + songID);

            // TODO: we don't know if transcoding ended successfully or not,
            // and there might be a race condition between errCallback deleting
            // the file and us trying to move it to the songCache

            // atomically move result to encodedPath
            if(fs.existsSync(incompletePath))
                fs.renameSync(incompletePath, encodedPath);

            progCallback(0, true);
        });
    });

    logger.verbose('transcoding ' + songID + '...');
    return function(err) {
        command.kill();
        logger.verbose('file: canceled preparing: ' + songID + ': ' + err);
        if(fs.existsSync(incompletePath))
            fs.unlinkSync(incompletePath);
        errCallback('canceled preparing: ' + songID + ': ' + err);
    };
};

// cache songID to disk.
// on success: progCallback must be called with true as argument
// on failure: errCallback must be called with error message
// returns a function that cancels preparing
fileBackend.prepareSong = function(songID, progCallback, errCallback) {
    var filePath = config.songCachePath + '/file/' + songID + '.opus';

    if(fs.existsSync(filePath)) {
        progCallback(0, true);
    } else {
        var cancelEncode = null;
        var canceled = false;
        var cancelPreparing = function() {
            canceled = true;
            if(cancelEncode)
                cancelEncode();
        };

        db.collection('songs').findById(songID, function (err, item) {
            if(canceled) {
                errCallback('song was canceled before encoding started');
            } else if(item) {
                var readStream = fs.createReadStream(item.file);
                cancelEncode = encodeSong(readStream, 0, songID, progCallback, errCallback);
                readStream.on('error', function(err) {
                    errCallback(err);
                });
            } else {
                errCallback('song not found in local db');
            }
        });

        return cancelEncode;
    }
};

fileBackend.isPrepared = function(songID) {
    var filePath = config.songCachePath + '/file/' + songID + '.opus';
    return fs.existsSync(filePath);
};

fileBackend.search = function(query, callback, errCallback) {
    db.collection('songs').find({ $text: { $search: query.terms} }).toArray(function (err, items) {
        // Also filter away special chars? (Remix) ?= Remix åäö日本穂?
        var termsArr = query.terms.split(' ');
        termsArr.forEach(function(e, i, arr) {arr[i] = e.toLowerCase()});
        for (var i in items) {
            items[i].score = 0;
            var words = [];
            if (items[i].title.split)
                words = words.concat(items[i].title.split(' '));
            if (items[i].artist.split)
                words = words.concat(items[i].artist.split(' '));
            if (items[i].album.split)
                words = words.concat(items[i].album.split(' '));
            words.forEach(function(e, i, arr) {arr[i] = e.toLowerCase()});
            for (var ii in words) {
                if (termsArr.indexOf(words[ii]) >= 0) {
                    items[i].score++;
                }
            }
        }
        items.sort(function(a, b) {
            return b.score - a.score; // sort by score
        })
        var results = {};
        results.songs = {};
        for (var song in items) {
            results.songs[items[song]._id.toString()] = {
                artist: items[song].artist,
                title: items[song].title,
                album: items[song].album,
                albumArt: null, // TODO: can we add this?
                duration: items[song].duration,
                songID: items[song]._id.toString(),
                score: 100, // TODO
                backendName: 'file',
                format: 'opus'
            };
            if (Object.keys(results.songs).length > config.searchResultCnt) break;
        }
        callback(results);
    });
};
var upserted = 0;
var probeCallback = function(err, probeData, next) {
    var formats = fileConfig.importFormats;
    if (probeData) {
        if (formats.indexOf(probeData.format.format_name) >= 0) { // Format is supported
            var song = {
                title: '',
                artist: '',
                album: '',
                duration: '0',
            };

            // some tags may be in mixed/all caps, let's convert every tag to lower case
            var key, keys = Object.keys(probeData.metadata);
            var n = keys.length;
            var metadata = {};
            while(n--) {
                key = keys[n];
                metadata[key.toLowerCase()] = probeData.metadata[key];
            }

            // try a best guess based on filename in case tags are unavailable
            var basename = path.basename(probeData.file);
            basename = path.basename(probeData.file, path.extname(basename));
            var splitTitle = basename.split(/\s-\s(.+)?/);

            if (!_.isUndefined(metadata.title)) {
                song.title = metadata.title;
            } else {
                song.title = splitTitle[1];
            }
            if (!_.isUndefined(metadata.artist)) {
                song.artist = metadata.artist;
            } else {
                song.artist = splitTitle[0];
            }
            if (!_.isUndefined(metadata.album)) {
                song.album = metadata.album;
            }

            song.file = probeData.file;

            song.duration = probeData.format.duration * 1000;
            db.collection('songs').update({file: probeData.file}, {'$set':song}, {upsert: true}, function(err, result) {
                if (result == 1) {
                    logger.debug('Upserted: ' + probeData.file);
                    upserted++;
                } else {
                    logger.error('error while updating db: ' + err);
                }

                next();
            });
        } else {
            logger.verbose('format not supported, skipping...');
            next();
        }
    } else {
        logger.error('error while probing:' + err);
        next();
    }
}

fileBackend.init = function(_player, _logger, callback) {
    player = _player;
    config = _player.config;
    logger = _logger;

    var fileConfigPath = config.getConfigDir() + 'file-config.json';
    try {
        fileConfig = require(fileConfigPath);
    } catch(e) {
        if(e.code === 'MODULE_NOT_FOUND') {
            logger.error('File backend is enabled, but no configuration file was found.');
            logger.error('Creating sample configuration file containing default settings into:');
            logger.error(fileConfigPath);

            mkdirp(config.getConfigDir());
            fs.writeFileSync(fileConfigPath, JSON.stringify({
                mongo:              "mongodb://localhost:27017/nodeplayer-file",
                importPath:         "/home/example/testlibrary",
                importFormats:      ["mp3", "flac", "ogg", "opus"],
                concurrentProbes:   4,
                followSymlinks:     true
            }, undefined, 4));

            logger.error('File created. Go edit it NOW! Relaunch nodeplayer when done configuring.');
            process.exit(0);
        } else {
            logger.error('unexpected error while loading file backend configuration:');
            logger.error(e);
        }
    }

    mkdirp(config.songCachePath + '/file/incomplete');

    db = require('mongoskin').db(fileConfig.mongo, {native_parser:true, safe:true});

    var importPath = fileConfig.importPath;

    // Adds text index to database for title, artist and album fields
    // TODO: better handling and error checking
    var cb = function(arg1, arg2) {logger.debug(arg1);logger.debug(arg2)}
    db.collection('songs').ensureIndex({ title: 'text', artist: 'text', album: 'text' }, cb);

    var options = {
        followLinks: fileConfig.followSymlinks
    };


    // create async.js queue to limit concurrent probes
    var q = async.queue(function(task, callback) {
        probe(task.filename, function(err, probeData) {
            probeCallback(err, probeData, function() {
                callback();
                task.next();
            });
        });
    }, fileConfig.concurrentProbes);

    // walk the filesystem and scan files
    // TODO: also check through entire DB to see that all files still exist on the filesystem
    var startTime = new Date();
    logger.info('Scanning directory: ' + importPath);
    walker = walk.walk(importPath, options);
    var scanned = 0;
    walker.on('file', function (root, fileStats, next) {
        var filename = path.join(root, fileStats.name);
        logger.verbose('Scanning: ' + filename);
        scanned++;
        logger.silly('q.length(): ' + q.length(), 'q.running(): ' + q.running());
        q.push({
            filename: filename,
            next: next
        });
    });
    walker.on('end', function() {
        logger.verbose('Scanned files: ' + scanned);
        logger.verbose('Upserted files: ' + upserted);
        logger.verbose('Done in: ' + Math.round((new Date() - startTime) / 1000) + ' seconds');

        // set fs watcher on media directory
        watch(importPath, {recursive: true, followSymlinks: fileConfig.followSymlinks}, function (filename) {
            if(fs.existsSync(filename)) {
                logger.debug(filename + ' modified or created, queued for probing');
                logger.silly('q.length(): ' + q.length(), 'q.running(): ' + q.running());
                q.push({
                    filename: filename,
                    next: function() {
                        logger.debug(filename + ' added/updated to db');
                    }
                });
            } else {
                logger.debug(filename + ' deleted');
                db.collection('songs').remove({ file: filename }, function (err, items) {
                    logger.debug(filename + ' deleted from db: ' + err + ', ' + items);
                });
            }
        });
    });

    // callback right away, as we can scan for songs in the background
    callback();
};
module.exports = fileBackend;
