import {deepAccess, isArray, logError, logInfo, mergeDeep, deepClone, deepSetValue, logWarn} from '../src/utils.js';
import {getOrigin} from '../libraries/getOrigin/index.js';
import {BANNER, NATIVE} from '../src/mediaTypes.js';
import {registerBidder} from '../src/adapters/bidderFactory.js';
import {includes} from '../src/polyfill.js';
import {convertOrtbRequestToProprietaryNative} from '../src/native.js';
import {ortbConverter} from '../libraries/ortbConverter/converter.js';
import {ORTB_MTYPES} from '../libraries/ortbConverter/processors/mediaType.js';
import {config} from '../src/config.js';

const BIDDER_CODE = 'rtbhouse';
const REGIONS = ['prebid-eu', 'prebid-us', 'prebid-asia'];
const ENDPOINT_URL = 'creativecdn.com/bidder/prebid/bids';
const FLEDGE_ENDPOINT_URL = 'creativecdn.com/bidder/prebidfledge/bids';
const FLEDGE_SELLER_URL = 'https://fledge-ssp.creativecdn.com';
const FLEDGE_DECISION_LOGIC_URL = 'https://fledge-ssp.creativecdn.com/component-seller-prebid.js';

const DEFAULT_CURRENCY_ARR = ['USD']; // NOTE - USD is the only supported currency right now; Hardcoded for bids
const SUPPORTED_MEDIA_TYPES = [BANNER, NATIVE];
const TTL = 55;
const GVLID = 16;

// Codes defined by OpenRTB Native Ads 1.1 specification
export const OPENRTB = {
  NATIVE: {
    IMAGE_TYPE: {
      ICON: 1,
      MAIN: 3,
    },
    ASSET_ID: {
      TITLE: 1,
      IMAGE: 2,
      ICON: 3,
      BODY: 4,
      SPONSORED: 5,
      CTA: 6
    },
    DATA_ASSET_TYPE: {
      SPONSORED: 1,
      DESC: 2,
      CTA_TEXT: 12,
    },
  }
};
const ORTB_MTYPES_CODES = Object.entries(ORTB_MTYPES).reduce((acc, [key, value]) => { acc[value] = key; return acc}, {});

function _logWarn(...args) {
  logInfo(...args)
}
function _logInfo(...args) {
  logInfo(...args)
}

const CONVERTER = ortbConverter({     
  context: {
      netRevenue: true,    // or false if your adapter should set bidResponse.netRevenue = false
      ttl: TTL,              // default bidResponse.ttl (when not specified in ORTB response.seatbid[].bid[].exp)  
      currency: DEFAULT_CURRENCY_ARR[0]
  },
  imp(buildImp, bidRequest, context) {
    const { bidderRequest } = context;
    // _logInfo('in imp(): bidRequest=',bidRequest)
    const imp = buildImp(bidRequest, context);
    // _logInfo('in imp(): after buildImp imp=', imp)
    // deepSetValue(imp, 'tagid', deepAccess(imp, 'ext.data.pbadslot'));
    deepSetValue(imp, 'tagid', bidRequest.adUnitCode.toString());
    
    mergeDeep(imp, _mapImpression(bidRequest, bidderRequest));
    if (!imp.bidfloor && bidRequest.params.bidfloor) {
      imp.bidfloor = parseFloat(bidRequest.params.bidfloor);
      _logInfo('Setting up FLOOR value to', imp.bidfloor)
    }
    return imp;
  },
  // overrides: {
  //   imp: {
  //     bidfloor(setBidFloor, imp, bidRequest, context) {
  //       // borrowed from OpenX :-)
  //       // seems like it's not needed - done automatically
  //       // enforce floors should always be in USD
  //       // TODO: does it make sense that request.cur can be any currency, but request.imp[].bidfloorcur must be USD?
  //       const floor = {};
  //       setBidFloor(floor, bidRequest, {...context, currency: DEFAULT_CURRENCY_ARR[0]});
  //       if (floor.bidfloorcur === DEFAULT_CURRENCY_ARR[0]) {
  //         Object.assign(imp, floor);
  //       }
  //       logWarn('floor:', floor)
  //     }
  //   }
  // }
  bidResponse(buildBidResponse, bid, context) {
    // bid.ext = {test:1}
    _logWarn('in bidResponse for bid', deepClone(bid))
    // this substitutes interpretBannerBid / interpretNativeBid
    // check if there's mediaType
    // if not skip that bid
    // if(!('mtype' in bid)) return;
    // or skip that bid if no bid.price
    if(!('price' in bid)) return;
    if (bid.adm.indexOf('{') === 0) {
      // native bid, adding mtype
      bid.mtype = ORTB_MTYPES_CODES[NATIVE]
      _logInfo('ORTB_MTYPES_CODES', ORTB_MTYPES_CODES)
      
      // interpretedBid = interpretNativeBid(bid);
      const native = JSON.parse(bid.adm).native;
      bid.adm = native;
      // IMPORTANT: there's something wrong with native bid response structure returned by the bidder
      // SOLVED: we don't have to call interpretNativeBid. We only have to attach $.native object to the actual bid.adm
    }

    const bidResponse = buildBidResponse(bid, context);
    _logWarn('in bidResponse for bid: buildBidResponse() returned', deepClone(bidResponse))
    // the only change needed is adding creativeId
    bidResponse.creativeId = bid.adid;
    // and adding ext if exists
    if (bid.ext) mergeDeep(bidResponse.ext, bid.ext);

    _logWarn('built bidResponse:', bidResponse)
    return bidResponse;
  },
  response(buildResponse, bidResponses, ortbResponse, context) {
    _logWarn('Building response for:\n', {buildResponse, bidResponses: deepClone(bidResponses), ortbResponse, context})
    //filter out bid responses which do not have cpm > 0
    // price may exist and is === 0 or there's no price prop at all (fledge req case)
    bidResponses = bidResponses.filter(bid => {
        _logWarn('==>bid:', deepClone(bid))
        return bid.cpm > 0
      });
    const response = buildResponse(bidResponses, ortbResponse, context);
    _logWarn('response() return value after buildResponse():', deepClone(response))
    _logWarn('ortbResponse:', deepClone(ortbResponse))
    
    // We have to separate FLEDGE seatbid[].bid[] bid objects which are merged via 
    // ext.igbid[].impid === seatbid[].bid[].impid
    // from other regular contextual bids

    
    if (ortbResponse.bidid && isArray(ortbResponse?.ext?.igbid)) {
      // we have fledge response
      // WARNING: source fledge_config can be obtained from ortbRequest.ext.fledge_config
      // so it has not to be returned by the bidder!

      const fledgeAuctionConfigsObj = {};
      // mimic the original response ([{},...])
      const { seller, decisionLogicUrl, sellerTimeout } = ortbResponse.ext;

      ortbResponse.ext.igbid.forEach((igbid) => {
        const perBuyerSignals = {};
        igbid.igbuyer.forEach(buyerItem => {
          perBuyerSignals[buyerItem.igdomain] = buyerItem.buyersignal
        });
        fledgeAuctionConfigsObj[igbid.impid] = {
            seller,
            decisionLogicUrl,
            interestGroupBuyers: Object.keys(perBuyerSignals),
            perBuyerSignals,
          };
        if(sellerTimeout) fledgeAuctionConfigsObj[igbid.impid].sellerTimeout = sellerTimeout;
      });
 
      const fledgeAuctionConfigs = Object.entries(fledgeAuctionConfigsObj).map(([bidId, cfg]) => {
        return {
          bidId,
          config: Object.assign({
            auctionSignals: {}
          }, cfg)
        }
      });
      const returnValue = {
        bids: response.bids,
        fledgeAuctionConfigs,
      }
      _logInfo('Response with FLEDGE:', returnValue);
      return returnValue
    }

    return response.bids;
  }
});

export const spec = {
  code: BIDDER_CODE,
  supportedMediaTypes: SUPPORTED_MEDIA_TYPES,
  gvlid: GVLID,

  isBidRequestValid: function (bid) {
    return !!(includes(REGIONS, bid.params.region) && bid.params.publisherId);
  },
  buildRequests: function (validBidRequests, bidderRequest) {
    const ortbRequest = CONVERTER.toORTB({ validBidRequests, bidderRequest });
    let computedEndpointUrl = ENDPOINT_URL;
    const firstBidRequest = validBidRequests[0];
    mergeDeep(ortbRequest, {
      site: mapSite(validBidRequests),
      // cur: DEFAULT_CURRENCY_ARR,
      test: firstBidRequest.params.test || 0,
    });
    if (bidderRequest && bidderRequest.gdprConsent && bidderRequest.gdprConsent.gdprApplies) {
      const consentStr = (bidderRequest.gdprConsent.consentString)
        ? bidderRequest.gdprConsent.consentString.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '';
      const gdpr = bidderRequest.gdprConsent.gdprApplies ? 1 : 0;
      deepSetValue(ortbRequest, 'regs.ext.gdpr', gdpr);
      deepSetValue(ortbRequest, 'user.ext.consent', consentStr);
    }
    if (firstBidRequest.schain) {
      const schain = mapSchain(firstBidRequest.schain);
      if (schain) {
        deepSetValue(ortbRequest, 'ext.schain', schain);
      }
    }
    // if (firstBidRequest.userIdAsEids) {
    //   deepSetValue(ortbRequest, 'user.ext.eids', firstBidRequest.userIdAsEids);
    // }
    _logInfo('bidderRequest:', bidderRequest)
    
    _logInfo('buildRequests: CONVERTER.toORTB:', deepClone(ortbRequest))

    if (bidderRequest.fledgeEnabled) {
      const fledgeConfig = config.getConfig('fledgeConfig') || {
        seller: FLEDGE_SELLER_URL,
        decisionLogicUrl: FLEDGE_DECISION_LOGIC_URL,
        sellerTimeout: 500
      };
      deepSetValue(ortbRequest, 'ext.fledge_config', fledgeConfig);
      computedEndpointUrl = FLEDGE_ENDPOINT_URL;
    }
    // if (bid.params.bcat) data.bcat = bid.params.bcat;
    // if (bid.params.badv) data.badv = bid.params.badv;
    // if (bid.params.bapp) data.bapp = bid.params.bapp;
  
    return {
      method: 'POST',
      url: 'https://' + firstBidRequest.params.region + '.' + computedEndpointUrl,
      data: ortbRequest
    };
  },
  _buildRequests: function (validBidRequests, bidderRequest) {
    /* const ortbRequest = CONVERTER.toORTB({ validBidRequests, bidderRequest })
    mergeDeep(ortbRequest, {
      site: mapSite(validBidRequests),
      // cur: DEFAULT_CURRENCY_ARR,
      test: validBidRequests[0].params.test || 0,
    });
    if (validBidRequests[0].schain) {
      const schain = mapSchain(validBidRequests[0].schain);
      if (schain) {
        deepSetValue(ortbRequest, 'ext.schain', schain);
      }
    }
    if (validBidRequests[0].userIdAsEids) {
      deepSetValue(ortbRequest, 'user.ext.eids', validBidRequests[0].userIdAsEids);
    }
    logInfo('buildRequests: CONVERTER.toORTB:', deepClone(ortbRequest)) */

    // convert Native ORTB definition to old-style prebid native definition
    _validBidRequests = convertOrtbRequestToProprietaryNative(validBidRequests);
    _logInfo('convertOrtbRequestToProprietaryNative:', _validBidRequests)
    validBidRequests = _validBidRequests;
    
    const request = {
      id: bidderRequest.bidderRequestId,
      imp: validBidRequests.map(slot => mapImpression(slot, bidderRequest)),
      site: mapSite(validBidRequests, bidderRequest),
      cur: DEFAULT_CURRENCY_ARR,
      test: validBidRequests[0].params.test || 0,
      source: mapSource(validBidRequests[0], bidderRequest),
    };

    if (bidderRequest && bidderRequest.gdprConsent && bidderRequest.gdprConsent.gdprApplies) {
      const consentStr = (bidderRequest.gdprConsent.consentString)
        ? bidderRequest.gdprConsent.consentString.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '';
      const gdpr = bidderRequest.gdprConsent.gdprApplies ? 1 : 0;
      request.regs = {ext: {gdpr: gdpr}};
      request.user = {ext: {consent: consentStr}};
    }
    if (validBidRequests[0].schain) {
      const schain = mapSchain(validBidRequests[0].schain);
      if (schain) {
        request.ext = {
          schain: schain,
        };
      }
    }

    if (validBidRequests[0].userIdAsEids) {
      const eids = { eids: validBidRequests[0].userIdAsEids };
      if (request.user && request.user.ext) {
        request.user.ext = { ...request.user.ext, ...eids };
      } else {
        request.user = {ext: eids};
      }
    }

    const ortb2Params = bidderRequest?.ortb2 || {};
    ['site', 'user', 'device', 'bcat', 'badv'].forEach(entry => {
      const ortb2Param = ortb2Params[entry];
      if (ortb2Param) {
        mergeDeep(request, { [entry]: ortb2Param });
      }
    });

    let computedEndpointUrl = ENDPOINT_URL;

    if (bidderRequest.fledgeEnabled) {
      const fledgeConfig = config.getConfig('fledgeConfig') || {
        seller: FLEDGE_SELLER_URL,
        decisionLogicUrl: FLEDGE_DECISION_LOGIC_URL,
        sellerTimeout: 500
      };
      mergeDeep(request, { ext: { fledge_config: fledgeConfig } });
      computedEndpointUrl = FLEDGE_ENDPOINT_URL;
    }

    return {
      method: 'POST',
      url: 'https://' + validBidRequests[0].params.region + '.' + computedEndpointUrl,
      data: JSON.stringify(request)
    };
  },
  _interpretOrtbResponse: function (serverResponse, originalRequest) {
    
    const responseBody = serverResponse.body;
    if (!isArray(responseBody)) {
      return [];
    }

    const bids = [];
    responseBody.forEach(serverBid => {
      if (!serverBid.price) { // price may exist and is === 0 or there's no price prop at all (fledge req case)
        return;
      }

      let interpretedBid;

      // try...catch would be risky cause JSON.parse throws SyntaxError
      if (serverBid.adm.indexOf('{') === 0) {
        interpretedBid = interpretNativeBid(serverBid);
      } else {
        interpretedBid = interpretBannerBid(serverBid);
      }
      if (serverBid.ext) interpretedBid.ext = serverBid.ext;

      bids.push(interpretedBid);
    });
    return bids;
  },
  interpretResponse: function (serverResponse, originalRequest) {
    _logWarn('originalRequest:', originalRequest)
    _logWarn('serverResponse:', serverResponse)
    if (!serverResponse.body) {
      serverResponse.body = {nbr: 0};
    } else if (isArray(serverResponse.body)) {
      // let's wrap the array which is actually seatbid.bid with the OpenRTB response object
      const seatbidBid = serverResponse.body;
      serverResponse.body = {
        seatbid: [{
          bid: seatbidBid,
          seat: BIDDER_CODE
        }]
      }
    }
    const ortbResponse = CONVERTER.fromORTB({response: serverResponse.body, request: originalRequest.data})//.bids;
    _logWarn('interpretResponse return value:', ortbResponse)
    return ortbResponse
  }
};
registerBidder(spec);

/**
 * @param {object} slot Ad Unit Params by Prebid
 * @returns {int} floor by imp type
 */
function applyFloor(slot) {
  const floors = [];
  if (typeof slot.getFloor === 'function') {
    Object.keys(slot.mediaTypes).forEach(type => {
      if (includes(SUPPORTED_MEDIA_TYPES, type)) {
        floors.push(slot.getFloor({ currency: DEFAULT_CURRENCY_ARR[0], mediaType: type, size: slot.sizes || '*' }).floor);
      }
    });
  }
  return floors.length > 0 ? Math.max(...floors) : parseFloat(slot.params.bidfloor);
}

function _mapImpression(bidRequest, bidderRequest) {
  if(_isBannerBid(bidRequest)) return {banner: _mapBanner(bidRequest)}
  if(_isNativeBid(bidRequest)) return {native: _mapNative(bidRequest)}
}

/**
 * @param {object} slot Ad Unit Params by Prebid
 * @returns {object} Imp by OpenRTB 2.5 §3.2.4
 */
function mapImpression(slot, bidderRequest) {
  const imp = {
    id: slot.bidId,
    banner: mapBanner(slot),
    native: mapNative(slot),
    tagid: slot.adUnitCode.toString()
  };

  const bidfloor = applyFloor(slot);
  if (bidfloor) {
    imp.bidfloor = bidfloor;
  }

  if (bidderRequest.fledgeEnabled) {
    imp.ext = imp.ext || {};
    imp.ext.ae = slot?.ortb2Imp?.ext?.ae
  } else {
    if (imp.ext?.ae) {
      delete imp.ext.ae;
    }
  }

  const tid = deepAccess(slot, 'ortb2Imp.ext.tid');
  if (tid && config.getConfig('enableTIDs')) {
    imp.ext = imp.ext || {};
    imp.ext.tid = tid;
  }

  return imp;
}

/**
 * @param {object} slot Ad Unit Params by Prebid
 * @returns {object} Banner by OpenRTB 2.5 §3.2.6
 */
function mapBanner(slot) {
  if (slot.mediaType === 'banner' ||
    deepAccess(slot, 'mediaTypes.banner') ||
    (!slot.mediaType && !slot.mediaTypes)) {
    var sizes = slot.sizes || slot.mediaTypes.banner.sizes;
    return {
      w: sizes[0][0],
      h: sizes[0][1],
      format: sizes.map(size => ({
        w: size[0],
        h: size[1]
      }))
    };
  }
}

function _isBannerBid(bidRequest) {
  return deepAccess(bidRequest, `mediaTypes.${BANNER}`)
}
function _isNativeBid(bidRequest) {
  return deepAccess(bidRequest, `mediaTypes.${NATIVE}`)
}

function _mapBanner(bidRequest) {
  const banner = {};
  if(_isBannerBid(bidRequest)) {
    let sizes = deepAccess(bidRequest, `mediaTypes.${BANNER}.sizes`);

    if (sizes) {
      banner.w = sizes[0][0];
      banner.h = sizes[0][1];
    }
  }
  return {...banner}
}

/**
 * @param {object} slot Ad Unit Params by Prebid
 * @returns {object} Site by OpenRTB 2.5 §3.2.13
 */
function mapSite(slot) {
  let pubId = 'unknown';
  let channel = null;
  if (slot && slot.length > 0) {
    pubId = slot[0].params.publisherId;
    channel = slot[0].params.channel &&
    slot[0].params.channel
      .toString()
      .slice(0, 50);
  }
  let siteData = {
    publisher: {
      id: pubId.toString(),
    },
    // page: bidderRequest.refererInfo.page,
    name: getOrigin()
  };
  if (channel) {
    siteData.channel = channel;
  }
  return siteData;
}

/**
 * @param {object} slot Ad Unit Params by Prebid
 * @returns {object} Source by OpenRTB 2.5 §3.2.2
 */
function mapSource(slot, bidderRequest) {
  const source = {
    tid: bidderRequest?.auctionId || '',
  };

  return source;
}

/**
 * @param {object} schain object set by Publisher
 * @returns {object} OpenRTB SupplyChain object
 */
function mapSchain(schain) {
  if (!schain) {
    return null;
  }
  if (!validateSchain(schain)) {
    logError('RTB House: required schain params missing');
    return null;
  }
  return schain;
}

/**
 * @param {object} schain object set by Publisher
 * @returns {object} bool
 */
function validateSchain(schain) {
  if (!schain.nodes) {
    return false;
  }
  const requiredFields = ['asi', 'sid', 'hp'];
  return schain.nodes.every(node => {
    return requiredFields.every(field => node[field]);
  });
}

function _mapNative(bidRequest) {
  const native = {}
  if(_isNativeBid(bidRequest)) {
    mergeDeep(native, {
      request: {
        assets: mapNativeAssets(bidRequest),
      },
      ver: '1.2'
    })
  }
  return {...native}
}
/**
 * @param {object} slot Ad Unit Params by Prebid
 * @returns {object} Request by OpenRTB Native Ads 1.1 §4
 */
function mapNative(slot) {
  if (slot.mediaType === 'native' || deepAccess(slot, 'mediaTypes.native')) {
    return {
      request: {
        assets: mapNativeAssets(slot)
      },
      ver: '1.1'
    }
  }
}

/**
 * @param {object} slot Slot config by Prebid
 * @returns {array} Request Assets by OpenRTB Native Ads 1.1 §4.2
 */
function mapNativeAssets(slot) {
  const params = slot.nativeParams || deepAccess(slot, 'mediaTypes.native');
  const assets = [];
  if (params.title) {
    assets.push({
      id: OPENRTB.NATIVE.ASSET_ID.TITLE,
      required: params.title.required ? 1 : 0,
      title: {
        len: params.title.len || 25
      }
    })
  }
  if (params.image) {
    assets.push({
      id: OPENRTB.NATIVE.ASSET_ID.IMAGE,
      required: params.image.required ? 1 : 0,
      img: mapNativeImage(params.image, OPENRTB.NATIVE.IMAGE_TYPE.MAIN)
    })
  }
  if (params.icon) {
    assets.push({
      id: OPENRTB.NATIVE.ASSET_ID.ICON,
      required: params.icon.required ? 1 : 0,
      img: mapNativeImage(params.icon, OPENRTB.NATIVE.IMAGE_TYPE.ICON)
    })
  }
  if (params.sponsoredBy) {
    assets.push({
      id: OPENRTB.NATIVE.ASSET_ID.SPONSORED,
      required: params.sponsoredBy.required ? 1 : 0,
      data: {
        type: OPENRTB.NATIVE.DATA_ASSET_TYPE.SPONSORED,
        len: params.sponsoredBy.len
      }
    })
  }
  if (params.body) {
    assets.push({
      id: OPENRTB.NATIVE.ASSET_ID.BODY,
      required: params.body.request ? 1 : 0,
      data: {
        type: OPENRTB.NATIVE.DATA_ASSET_TYPE.DESC,
        len: params.body.len
      }
    })
  }
  if (params.cta) {
    assets.push({
      id: OPENRTB.NATIVE.ASSET_ID.CTA,
      required: params.cta.required ? 1 : 0,
      data: {
        type: OPENRTB.NATIVE.DATA_ASSET_TYPE.CTA_TEXT,
        len: params.cta.len
      }
    })
  }
  return assets;
}

/**
 * @param {object} image Prebid native.image/icon
 * @param {int} type Image or icon code
 * @returns {object} Request Image by OpenRTB Native Ads 1.1 §4.4
 */
function mapNativeImage(image, type) {
  const img = {type: type};
  if (image.aspect_ratios) {
    const ratio = image.aspect_ratios[0];
    const minWidth = ratio.min_width || 100;
    img.wmin = minWidth;
    img.hmin = (minWidth / ratio.ratio_width * ratio.ratio_height);
  }
  if (image.sizes) {
    const size = isArray(image.sizes[0]) ? image.sizes[0] : image.sizes;
    img.w = size[0];
    img.h = size[1];
  }
  return img
}

/**
 * @param {object} serverBid Bid by OpenRTB 2.5 §4.2.3
 * @returns {object} Prebid banner bidObject
 */
function interpretBannerBid(serverBid) {
  return {
    requestId: serverBid.impid,
    mediaType: BANNER,
    cpm: serverBid.price,
    creativeId: serverBid.adid,
    ad: serverBid.adm,
    width: serverBid.w,
    height: serverBid.h,
    ttl: TTL,
    meta: {
      advertiserDomains: serverBid.adomain
    },
    netRevenue: true,
    currency: 'USD'
  }
}

/**
 * @param {object} serverBid Bid by OpenRTB 2.5 §4.2.3
 * @returns {object} Prebid native bidObject
 */
function interpretNativeBid(serverBid) {
  return {
    requestId: serverBid.impid,
    mediaType: NATIVE,
    cpm: serverBid.price,
    creativeId: serverBid.adid,
    width: 1,
    height: 1,
    ttl: TTL,
    meta: {
      advertiserDomains: serverBid.adomain
    },
    netRevenue: true,
    currency: 'USD',
    native: interpretNativeAd(serverBid.adm),
  }
}

/**
 * @param {string} adm JSON-encoded Request by OpenRTB Native Ads 1.1 §4.1
 * @returns {object} Prebid bidObject.native
 */
function interpretNativeAd(adm) {
  const native = JSON.parse(adm).native;
  const EXAMPLE = {
    "ver": "1.2",
    "assets": [
        {
            "id": 0,
            "title": {
                "text": "Shop online bij Scapino"
            }
        },
        {
            "id": 1,
            "data": {
                "value": "Levi's heren hoodie € 39,00"
            }
        },
        {
            "id": 2,
            "img": {
                "url": "https://ams.creativecdn.com/images?id=9cdd110b58cfbeb5dc0009954b386bf6bc6d42e3&w=1200&h=628&o=1083943124&fid=PWSwu1fsEbK00nC07fch",
                "w": 1200,
                "h": 628
            }
        }
    ],
    "link": {
        "url": "https://ams.creativecdn.com/clicks?id=20230908_75kIeJeYXl0mw9wY3h7s&tk=7gsPFGhVdn3ZR6hVMuuMjEuF5Z4eKAcex-CtHP4ekMG0sTLwNUhxOs8xTOGMkr6jAOdcdkr_lcGpFyEK7lRb1Zzk2IA8cidFxv8vXlRvw3wj9qc8A6STiHXx0CkVjrKl3IMewrIXxXxymBvJzX-K5KcJONX2RL70weOBEy3dwDcsn3DH5Ty5bNRT2lDcy_iZ1q8IseHrLiHU8yCa9t6x9sGJwji4VJX5duuu2BEPdsDsAn_nqYga0XkOsF6m5GXSMaE3CVf-UhZhr6vs2lz-QSMgQG_7uX-jg83FsxU0qe90r0-65SCHHfNofEjnxEbfGmFwB6RTQWQAU_8kElKo2O6LDAoI7v_C7-P3OTXPTrMT430BN-kPeqLXxYFpehymknD_f9R_lHlEfvwHKaxAxU5w5WiDBTwbWzy1W-pqVrJ98nZUvRbR3p_8HNXRuTCaApHcZXnxLu24QDen9YeBMuDMLylCJFq3AYKVa0EHun4uIHju5QO3VJAqBFHbKZgj6cYZoDX8WepmW7eUjsoCaBcoAnWdFY2BCgJDFbyLJD8AV_NnpblEOVY7o-Pa3lta"
    },
    "imptrackers": [
        "https://ams.creativecdn.com/win-notify?tk=D-VYg-SHtI_o5i1x8IRyx5sqvEQ_fjQsAYnVP0zQQwkZo9yEwpzJp8wkCX4XRjzbTAQDzHlNQSrNytfSI3-Vw4Y0hj4eQRcQ3bTpv4gldIAGREh9akYE3kCP4tqHKGRwF3xemTws4n7CR3OyR-YPSF9dbeyO6dyWs7VK6bCNonkFuU-X-GEok8XEiizq0LV0B6hotxVfBwJ4jK9pXTPUZhwDSpSFAdmIOthqxsxno-Oow9qqN5ZsW-83wcVnNzIPhmNOknp0DLXS6lytF1tnc5dkEwc42FxYt4lroqpxDbBDOqL_qrBeKJuMFmsubuQNNnxM_E__E1iOfBrCgDdpWIRej2jzEozvlcWQbrxUvrSPo3qDLuK6LBkaVKpNE7KRRrxX5_lCryW0tlV_Jk9CWfRyu-yXFS2UG7NaevrFSzQCPBuT__OKD8KMTMJXzGRFxX-CWVxM2xj0Z9h16xnpH09W8zccTC71xSdzvlgZJDc4yoe6ecDlWVxsz5iw2tdfUyg5rNrWy6Ae3X2Wc7z5sAl6fVdCEOmo2t6jGrPBT-BbuPrmPoriD1iyYzaubmaE&wp=4.2370751591611105E-4&tdc=ams"
    ]
};

  logWarn('native ad parsed:', native)
  const result = {
    clickUrl: encodeURI(native.link.url),
    impressionTrackers: native.imptrackers
  };
  native.assets.forEach(asset => {
    switch (asset.id) {
      case OPENRTB.NATIVE.ASSET_ID.TITLE: // 1
        result.title = asset.title.text;
        break;
      case OPENRTB.NATIVE.ASSET_ID.IMAGE: // 2
        result.image = {
          url: encodeURI(asset.img.url),
          width: asset.img.w,
          height: asset.img.h
        };
        break;
      case OPENRTB.NATIVE.ASSET_ID.ICON: // 3
        result.icon = {
          url: encodeURI(asset.img.url),
          width: asset.img.w,
          height: asset.img.h
        };
        break;
      case OPENRTB.NATIVE.ASSET_ID.BODY: // 4
        result.body = asset.data.value;
        break;
      case OPENRTB.NATIVE.ASSET_ID.SPONSORED: // 5
        result.sponsoredBy = asset.data.value;
        break;
      case OPENRTB.NATIVE.ASSET_ID.CTA: // 6
        result.cta = asset.data.value;
        break;
    }
  });
  return result;
}
