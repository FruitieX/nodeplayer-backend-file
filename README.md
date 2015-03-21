nodeplayer-backend-file
=======================

[![Build Status](https://travis-ci.org/FruitieX/nodeplayer-backend-file.svg?branch=master)](https://travis-ci.org/FruitieX/nodeplayer-backend-file)

Local file backend for nodeplayer

Setup
-----

* Install and configure `mongodb` on your system
* Enable backend `file` in: `~/.nodeplayer/config/core.json`
* Run nodeplayer once to generate sample config file: `npm start`
* Edit `~/.nodeplayer/config/file.json`. You may want to check at least options
  `mongo`, `rescanAtStart`, `importPath`.

