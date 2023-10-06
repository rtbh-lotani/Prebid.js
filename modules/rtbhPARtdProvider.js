import {isStr, logError} from '../src/utils.js';
import {submodule} from '../src/hook.js';
import { loadExternalScript } from '../src/adloader.js';

const MODULE_NAME = 'rtbhPA';
const TAGDOMAIN = 'tags.creativecdn.com';
export const RTBH_EVENTS = 'rtbhEvents';

window[RTBH_EVENTS] = window[RTBH_EVENTS] || [];

function executePubvertiserTag(tagId, region) {
  (function (w, d, dn, t) {
    w[dn] = w[dn] || [];
    w[dn].push({ eventType: 'init', value: t, dc: region });
    const scriptUrl = `https://${TAGDOMAIN}/${tagId}.js`;
    loadExternalScript(scriptUrl, MODULE_NAME);
  })(window, document, RTBH_EVENTS, tagId);
  window[RTBH_EVENTS].push(
    {
      eventType: 'placebo',
    }
  );
}

function init(rtdConfig) {
  const { tagId, region = '' } = rtdConfig?.params || {};

  if (!tagId || !isStr(tagId) || !isStr(region)) {
    logError(`${MODULE_NAME}: params.tagId and params.region should be strings`);
    return false;
  }

  executePubvertiserTag(tagId, region);
  return true;
}

export const subModuleObj = {
  name: MODULE_NAME,
  init: init
};

function registerSubModule() {
  submodule('realTimeData', subModuleObj);
}

registerSubModule();
