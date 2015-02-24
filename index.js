var walk = require('walk');
var probe = require('node-ffprobe');
var path = require('path');
var mkdirp = require('mkdirp');
var url = require('url');
var fs = require('fs');
var ffmpeg = require('fluent-ffmpeg');

var fileBackend = {};
fileBackend.name = 'file';

var config, walker, db, medialibraryPath;

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
            console.log('file: error while transcoding ' + songID + ': ' + err);
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
            console.log('transcoding ended for ' + songID);

            // TODO: we don't know if transcoding ended successfully or not,
            // and there might be a race condition between errCallback deleting
            // the file and us trying to move it to the songCache

            // atomically move result to encodedPath
            if(fs.existsSync(incompletePath))
                fs.renameSync(incompletePath, encodedPath);

            progCallback(0, true);
        });
    });

    console.log('transcoding ' + songID + '...');
    return function(err) {
        command.kill();
        console.log('file: canceled preparing: ' + songID + ': ' + err);
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
                cancelEncode = encodeSong(fs.createReadStream(item.file), 0, songID, progCallback, errCallback);
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
    var formats = ['mp3'];
    if (probeData) {
        if (formats.indexOf(probeData.format.format_name) >= 0) { // Format is supported
            var song = {
                title: '',
                artist: '',
                album: '',
                duration: '0',
            };
            if (probeData.metadata.title != undefined)
                song.title = probeData.metadata.title;
            if (probeData.metadata.artist != undefined)
                song.artist = probeData.metadata.artist;
            if (probeData.metadata.album != undefined)
                song.album = probeData.metadata.album;
            song.duration = probeData.format.duration * 1000;
            db.collection('songs').update({file: probeData.file}, {'$set':song}, {upsert: true}, function(err, result) {
                if (result == 1) {
                    console.log('Upserted: ' + probeData.file);
                    upserted++;
                } else {
                    console.log('error while updating db: ' + err);
                }

                next();
            });
        }
    } else {
        console.log('error while probing:' + err);
        next();
    }
}

fileBackend.init = function(_player, callback) {
    player = _player;
    config = _player.config;

    mkdirp(config.songCachePath + '/file/incomplete');

    db = require('mongoskin').db(config.mongo, {native_parser:true, safe:true});

    mediaLibraryPath = config.mediaLibraryPath;

    // Adds text index to database for title, artist and album fields
    // TODO: better handling and error checking
    var cb = function(arg1, arg2) {console.log(arg1);console.log(arg2)}
    db.collection('songs').ensureIndex({ title: 'text', artist: 'text', album: 'text' }, cb);

    var options = {
        followLinks: false
    };

    // Walk the filesystem and scan files
    /* TODO: smarter decision on what to probe. Could be limitted to only files
     * matching the prefix and also not reprobing files already in the database.
     */
    var startTime = new Date();
    console.log('Scanning directory: ' + mediaLibraryPath);
    walker = walk.walk(mediaLibraryPath, options);
    var scanned = 0;
    walker.on('file', function (root, fileStats, next) {
        file = path.join(root, fileStats.name);
        console.log('Scanning: ' + file)
            scanned++;
        probe(file, function(err, probeData) {
            probeCallback(err, probeData, next)
        });
    });
    walker.on('end', function() {
        console.log('Scanned files: ' + scanned);
        console.log('Upserted files: ' + upserted);
        console.log('Done in: ' + Math.round((new Date() - startTime) / 1000) + ' seconds');
        callback();
    });
};
module.exports = fileBackend;
