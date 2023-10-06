## Overview

Module Name: RTB House Prime Audience Realtime Data Module  
Module Type: Rtd Provider  
Maintainer: integrations@primeaudience.com

## Description

This module is intended to be used by Prime Audience (https://primeaudience.com) partners and puts customized tagging script onto publisher's web page.

## Integration

Build the RTB House Prime Audience RTD Module along with your bid adapter and other modules into your prebid.js build with:

```
gulp build --modules="rtbhPARtdProvider,rtdModule,..."
```

## Configuration

This module is configured as part of the `realTimeData.dataProviders` object. See https://docs.prebid.org/dev-docs/publisher-api-reference/setConfig.html#real-time-data-modules for details.

|    Name    |  Scope   | Description                  |     Example     |  Type  |
|:----------:|:--------:|:-----------------------------|:---------------:|:------:|
|    `name`    | required | Real time data module name   | `'rtbhPA'` | `string` |
|   `params`   | required |                              |                 | `Object` |
| `params.tagId` | required | Your Prime Audience customer ID, [Reach out to us](https://www.primeaudience.com/#contact) to know more! |   `'customerID'`    | `string` |
| `params.region`     | optional | Publisher related geo region. Defaults to `'ams'`. Other values: `'us', 'asia'` | `'us'`   | `string` |

### Example

```javascript
pbjs.setConfig({
    "realTimeData": {
        "dataProviders": [
            {
                "name": "rtbhPA",
                "params": {
                    "tagId": "customerID",
                    "region": "us",
                }
            }
        ]
    }
});
```