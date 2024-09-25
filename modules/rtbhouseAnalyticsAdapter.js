import adapter from '../libraries/analyticsAdapter/AnalyticsAdapter.js';
import adapterManager from '../src/adapterManager.js';
import { EVENTS } from '../src/constants.js';
import { ajax, sendBeacon } from '../src/ajax.js';
import { deepAccess, deepClone, isArray } from '../src/utils.js';

const {
  AUCTION_INIT,
  AUCTION_END,
  BID_WON,
  BID_TIMEOUT,
  BID_RESPONSE,
  BIDDER_ERROR,
  BID_REJECTED,
  BID_ACCEPTED,
  BID_REQUESTED,
  SET_TARGETING,
  AD_RENDER_FAILED,
  AD_RENDER_SUCCEEDED,
  AUCTION_TIMEOUT,
  BIDDER_DONE,
  RUN_PAAPI_AUCTION,
  PAAPI_BID,
  PAAPI_NO_BID,
  PAAPI_ERROR,
  ADD_AD_UNITS,
  REQUEST_BIDS,
  BEFORE_BIDDER_HTTP,
  BEFORE_REQUEST_BIDS,
} = EVENTS;

const URL = 'https://tracker.creativecdn.com/prebid-analytics';
const ANALYTICS_TYPE = 'endpoint';
const analyticsName = 'RTBHouse Analytics';
const BIDDER_CODE = 'rtbhouse';
const GVLID = 16;

const defaultBatchDelay = 100;
const defaultBatchSize = 5;
let rtbhParams = {};
let initOptions;
let timer;
let batch = [];


let rtbhouseAnalyticsAdapter = Object.assign({},
  adapter({
    url: URL,
    analyticsType: ANALYTICS_TYPE,
  }),
  {
    track({ eventType, args, id, elapsedTime }) {
      switch (eventType) {
        // temporary unify almost all events
        // case AUCTION_INIT:
        // case AUCTION_TIMEOUT:
        // case AUCTION_END:
        // case RUN_PAAPI_AUCTION:
        // case PAAPI_BID:
        // case PAAPI_NO_BID:
        // case BIDDER_DONE:
        //   auctionHandler(eventType, args);
        //   break;
        // case BID_REQUESTED:
        //   if (args.bidderCode === BIDDER_CODE) {
        //     for (const bid of args.bids) {
        //       const bidParams = bid.params?.length ? bid.params[0] : bid.params;
        //       rtbhParams[bid.bidId] = bidParams;
        //     }
        //   };
        //   break;
        // case BID_RESPONSE:
        // case BID_WON:
        // case BID_TIMEOUT:
        // case BID_REJECTED:
        // case BID_ACCEPTED:
        //   bidHandler(eventType, args);
        //   break;
        case PAAPI_ERROR:
        case BIDDER_ERROR:
        case AD_RENDER_FAILED: // arg is: Object containing ‘reason’ and ‘message’
          onError(eventType, args, elapsedTime);
          break;
          // add like BIDDER_ERROR
        case AD_RENDER_SUCCEEDED:
          onAdRender(eventType, args, elapsedTime);
          break;
        // case SET_TARGETING:
        //   sendDataToServer({ eventType, args });
        // case ADD_AD_UNITS:
        // case REQUEST_BIDS:
        // case BEFORE_BIDDER_HTTP:
        // case BEFORE_REQUEST_BIDS:
          // do nothing
          // break;
        default:
          sendDataToServer({ eventType, args, id, elapsedTime });  
          break;
      }
    }
  }
);

rtbhouseAnalyticsAdapter.originEnableAnalytics = rtbhouseAnalyticsAdapter.enableAnalytics
rtbhouseAnalyticsAdapter.enableAnalytics = function (config) {
  initOptions = config.options || {}
  rtbhouseAnalyticsAdapter.originEnableAnalytics(config)
}

rtbhouseAnalyticsAdapter.originDisableAnalytics = rtbhouseAnalyticsAdapter.disableAnalytics
rtbhouseAnalyticsAdapter.disableAnalytics = function () {
  rtbhouseAnalyticsAdapter.originDisableAnalytics()
}

const removeConsentFromBid = (bid) => {
  const userExt = deepAccess(bid, 'ortb2.user.ext');
  if(userExt) delete userExt.consent;
}

const processSingleBatchElement = (elem) => {
  // remove unnecessary data from the elem:
  // args.gdprConsent, args.ortb2.user.ext.consent, args.bids[].ortb2.user.ext.consent
  // args.bidderRequests[].gdprConsent, args.bidderRequests[].bids[].ortb2.user.ext.consent
  const args = elem.args;
  if(!args) return;
  delete args.gdprConsent;
  const userExt = deepAccess(args, 'ortb2.user.ext');
  if(userExt) delete userExt.consent;

  const argsBids = args.bids || [];
  const argsBidderRequests = args.bidderRequests || [];
  argsBids.forEach(removeConsentFromBid);
  argsBidderRequests.forEach(rq => {
    delete rq.gdprConsent;
    const bids = rq.bids || [];
    bids.forEach(removeConsentFromBid);
  });

}

const _sendDataToServer = (data) => {
  // make sure no-cors is set/not needed
  // const clonedData = deepClone(data);
  if(!isArray(data)) data = [data];
  data.forEach((elem) => processSingleBatchElement(elem));

  const stringifiedData = JSON.stringify(data);
  const {url = URL, useBeacon = false, customHeaders } = initOptions;
  const beaconSent = useBeacon && sendBeacon(url, stringifiedData);
  if(!beaconSent) {
    ajax(
      url, 
      () => logInfo(`${analyticsName} sent events batch of length ${data.length}`),
      stringifiedData, 
      {contentType: 'text/plain', method: 'POST', fetchMode: 'no-cors', customHeaders} 
    );
  }
}

const processBatch = () => {
  _sendDataToServer(batch);
  batch = [];
}

const sendDataToServer = (data) => {
  const { batchSize = defaultBatchSize, batchDelay = defaultBatchDelay } = initOptions;
  if(data != null) {
    batch.push(data);
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    if(batch.length >= batchSize) {
      processBatch();
    } else {
      timer = setTimeout(processBatch, batchDelay);
    }
  }
}

const auctionHandler = (eventType, data) => {
  const auctionData = {
    auctionId: data.auctionId,
    status: eventType,
    timeout: data.timeout,
    metrics: data.metrics,
    bidderRequests: data.bidderRequests?.map(bidderRequest => {
      delete bidderRequest.gdprConsent;
      delete bidderRequest.refererInfo;
      return bidderRequest;
    }).filter(request => request.bidderCode === BIDDER_CODE),
  }

  sendDataToServer({ eventType, auctionData });
}

const bidHandler = (eventType, bid) => {
  let bids = bid.length ? bid : [ bid ];

  for (const bidObj of bids) {
    let bidToSend;

    if (bidObj.bidderCode === BIDDER_CODE) {
      if (eventType === BID_WON) {
        bidToSend = {
          cpm: bidObj.cpm,
          auctionId: bidObj.auctionId
        };
      } else continue;
    }

    bidToSend = bidObj;

    if (eventType === BID_REJECTED) {
      bidToSend.params = rtbhParams[bid.requestId];
    }

    sendDataToServer({ eventType, bid: bidToSend });
  }
}

const onError = (eventType, data, elapsedTime) => {
  const message = eventType == AD_RENDER_FAILED ? `${data.reason}\n${data.message}` : data.error;
  sendDataToServer({
    eventType,
    elapsedTime,
    error: message,
    ...(eventType == AD_RENDER_FAILED ? {} : 
      {
        bidderRequests: data?.bidderRequests?.length
          ? data.bidderRequests.filter(request => request.bidderCode === BIDDER_CODE)
          : [ data.bidderRequest ]
      }
    )
  });
}

const onAdRender = (eventType, data, elapsedTime) => {
  if (data?.bid?.bidderCode === BIDDER_CODE) {
    sendDataToServer({ eventType, renderData: data, elapsedTime });
  }
}

adapterManager.registerAnalyticsAdapter({
  adapter: rtbhouseAnalyticsAdapter,
  code: BIDDER_CODE,
  gvlid: GVLID
})

export default rtbhouseAnalyticsAdapter;
