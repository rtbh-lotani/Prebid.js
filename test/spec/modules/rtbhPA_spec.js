import { subModuleObj, RTBH_EVENTS } from '../../../modules/rtbhPARtdProvider.js';
import { loadExternalScript } from '../../../src/adloader.js';
import { assert } from 'chai';

const config = {
  dataProviders: [{
    'name': 'rtbhPA',
    'params': {
      'tagId': 'publisher_id',
      'region': 'region'
    }
  }]
};

describe('rtbhPA realtime module', function () {
  afterEach(function () {
    delete global.window[RTBH_EVENTS];
  });

  it('init should return false when config is empty', function () {
    assert.isFalse(subModuleObj.init({}));
    assert.isFalse(loadExternalScript.called);
  });

  it('init should return false when config.params.tagId is empty', function () {
    assert.isFalse(subModuleObj.init({ params: {} }));
  });

  it('init should return false when config.params.tagId is not string', function () {
    assert.isFalse(subModuleObj.init({ params: { tagId: 123 } }));
  });

  it('init should return false when config.params.tagId is empty string', function () {
    assert.isFalse(subModuleObj.init({ params: { tagId: '' } }));
  });

  it('init should return false when config.params.region is not string', function () {
    assert.isFalse(subModuleObj.init({ params: { tagId: 'x', region: 12345 } }));
  });

  it('init should return true when config.params: tagId is non-empty string and region is undefined', function () {
    assert.isTrue(subModuleObj.init({ params: { tagId: 'x' } }));
    assert.isTrue(loadExternalScript.called);
  });

  it('init should return true when config.params: tagId is non-empty string and region is empty string', function () {
    assert.isTrue(subModuleObj.init({ params: { tagId: 'x', region: '' } }));
    assert.isTrue(loadExternalScript.called);
  });

  describe('init called with proper params', function () {
    it('init should return true when config.params: tagId and region are passed and are string typed', function () {
      assert.isTrue(subModuleObj.init(config.dataProviders[0]));
      assert.isTrue(loadExternalScript.called);
    });

    describe('global window.${RTBH_EVENTS} object analysis', function () {
      beforeEach(function () {
        subModuleObj.init(config.dataProviders[0]);
      });

      it(`${RTBH_EVENTS} key should exist in window`, function () {
        assert.hasAnyKeys(global.window, RTBH_EVENTS);
      });

      it(`window.${RTBH_EVENTS} should be an array`, function () {
        assert.isArray(global.window[RTBH_EVENTS]);
      });

      it(`window.${RTBH_EVENTS} should be a non-empty array`, function () {
        assert.isNotEmpty(global.window[RTBH_EVENTS]);
      });

      it(`window.${RTBH_EVENTS} should be an array with at least two elements`, function () {
        assert.isAtLeast(global.window[RTBH_EVENTS].length, 2);
      });

      it(`window.${RTBH_EVENTS} first element should be an object`, function () {
        assert.isObject(global.window[RTBH_EVENTS][0]);
      });

      it(`window.${RTBH_EVENTS} second element should be an object`, function () {
        assert.isObject(global.window[RTBH_EVENTS][1]);
      });

      it(`window.${RTBH_EVENTS} first element should contain all keys: 'eventType', 'value', 'dc'`, function () {
        assert.containsAllKeys(global.window[RTBH_EVENTS][0], ['eventType', 'value', 'dc']);
      });

      it(`window.${RTBH_EVENTS} first element should be deeply equal to {eventType: 'init', value: '${config.dataProviders[0].params.tagId}', dc: '${config.dataProviders[0].params.region}'}`, function () {
        assert.deepEqual(global.window[RTBH_EVENTS][0], {
          eventType: 'init',
          value: config.dataProviders[0].params.tagId,
          dc: config.dataProviders[0].params.region
        });
      });

      it(`window.${RTBH_EVENTS} second element should contain 'eventType' key`, function () {
        assert.hasAnyKeys(global.window[RTBH_EVENTS][1], 'eventType');
      });

      it(`window.${RTBH_EVENTS} second element's eventType key value should be equal to 'placebo'`, function () {
        assert.equal(global.window[RTBH_EVENTS][1].eventType, 'placebo');
      });
    });
  });
});
