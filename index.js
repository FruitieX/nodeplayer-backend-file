var send = require('send');
var walk = require('walk');
var probe = require('node-ffprobe');
var path = require('path');
var mkdirp = require('mkdirp');
var url = require('url');
var fs = require('fs');
var ffmpeg = require('fluent-ffmpeg');

var fileBackend = {};

var config, walker, db, medialibraryPath;

// TODO: seeking
var encodeSong = function(origStream, seek, songID, callback, errCallback) {
    var incompletePath = config.songCachePath + '/file/incomplete/' + songID + '.opus';
    var encodedPath = config.songCachePath + '/file/' + songID + '.opus';

    var command = ffmpeg(origStream)
        .noVideo()
        .audioCodec('libopus')
        .audioBitrate('192')
        .on('end', function() {
            console.log('successfully transcoded ' + songID);

            // atomically (I hope so) move result to encodedPath
            fs.renameSync(incompletePath, encodedPath);
            callback();
        })
    .on('error', function(err) {
        console.log('file: error while transcoding ' + songID + ': ' + err);
        if(fs.existsSync(incompletePath))
            fs.unlinkSync(incompletePath);
        errCallback();
    })
    .save(incompletePath);

    console.log('transcoding ' + songID + '...');
    return function(err) {
        command.kill();
        console.log('file: canceled preparing: ' + songID + ': ' + err);
        if(fs.existsSync(incompletePath))
            fs.unlinkSync(incompletePath);
        errCallback();
    };
};

// cache songID to disk.
// on success: callback must be called
// on failure: errCallback must be called with error message
fileBackend.prepareSong = function(songID, callback, errCallback) {
    console.log('fileBackend.cache ' + songID);
    db.collection('songs').findById(songID, function (err, item) {
        if(item) {
            var encodedPath = config.songCachePath + '/file/' + songID + '.opus';
            if(fs.existsSync(encodedPath)) {
                console.log('song found: ' + songID);
                callback();
            } else {
                encodeSong(fs.createReadStream(item.file), 0, songID, callback, errCallback);
            }
        } else {
            errCallback('song not found in local db');
        }
    });
};
fileBackend.search = function(query, callback, errCallback) {
    db.collection('songs').find({ $text: { $search: query.terms} }).toArray(
            function (err, items) {
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
                    results.songs.push({
                        artist: items[song].artist,
                        title: items[song].title,
                        album: items[song].album,
                        albumArt: null, // TODO: can we add this?
                        duration: items[song].duration,
                        songID: items[song]._id,
                        score: 100, // TODO
                        backendName: 'file',
                        format: 'opus'
                    });
                    if (results.songs.length > config.searchResultCnt) break;
                }
                // console.log(songs);
                callback(songs);
            });
};
var upserted = 0;
var toProbe = 0;
var probeCallback = function(err, probeData) {
    toProbe--;
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
            db.collection('songs').update({file: probeData.file}, {'$set':song}, {upsert: true},
                    function(err, result) {
                        if (result == 1) {
                            console.log('Upserted: ' + probeData.file);
                            upserted++;
                        } else
                            console.log(err);
                    });
        }
    } else if (err) {
        console.log(err);
    }
}

fileBackend.init = function(_config, callback) {
    console.log('fileBackend.init');
    config = _config;

    mkdirp(config.songCachePath + '/file/incomplete');

    db = require('mongoskin').db(config.mongo, {native_parser:true, safe:true});

    medialibraryPath = config.mediaLibraryPath;

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
    console.log('Scanning directory: ' + medialibraryPath);
    walker = walk.walk(medialibraryPath, options);
    var scanned = 0;
    walker.on('file', function (root, fileStats, next) {
        file = path.join(root, fileStats.name);
        console.log('Scanning: ' + file)
            scanned++;
        toProbe++;
        probe(file, probeCallback);
        next();
    });
    walker.on('end', function() {
        // Wait until all probes are ready
        var scanResultInterval = setInterval(function() {
            if (toProbe == 0) {
                console.log('Scanned files: ' + scanned);
                console.log('Upserted files: ' + upserted);
                console.log('Done in: ' + Math.round((new Date() - startTime) / 1000) + ' seconds');
                clearInterval(scanResultInterval);
            }
        }, 200);
    });
};
fileBackend.middleware = function(req, res, next) {
    console.log('fileBackend.middleware');
    var id = url.parse(req.url).pathname;
    id = id.substr(1);
    id = id.split('.')[0];

    db.collection('songs').findById(id, function (err, item) {
        console.log(id + ': ' + item.file);

        send(req, item.file).pipe(res);
    });

};
module.exports = fileBackend;
