'use strict';

process.env.NODE_ENV = 'test';

/*jshint expr: true*/
var should = require('chai').should();
var _ = require('underscore');
var plugin = require('../');

describe('plugin module', function() {
    it('should export a init function', function() {
        plugin.init.should.be.ok.and.should.be.a.Function;
    });
    it('should export a search function', function() {
        plugin.search.should.be.ok.and.should.be.a.Function;
    });
    it('should export an isPrepared function', function() {
        plugin.isPrepared.should.be.ok.and.should.be.a.Function;
    });
    it('should export a prepareSong function', function() {
        plugin.prepareSong.should.be.ok.and.should.be.a.Function;
    });
});
