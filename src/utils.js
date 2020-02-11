
function startsWithAny(value, iter) {
  for (let str of iter) {
    if (value.startsWith(str)) {
      return true;
    }
  }

  return false;
}

function getTS(iso) {
  return iso.replace(/[-:T]/g, '').slice(0, 14);
}

function tsToDate(ts) {
  if (!ts) {
    return new Date();
  }

  if (ts.length < 14) {
    ts += "00000000000000".substr(ts.length);
  }

  const datestr = (ts.substring(0, 4) + "-" +
    ts.substring(4, 6) + "-" +
    ts.substring(6, 8) + "T" +
    ts.substring(8, 10) + ":" +
    ts.substring(10, 12) + ":" +
    ts.substring(12, 14) + "-00:00");

  return new Date(datestr);
};

function tsToSec(ts) {
  return tsToDate(ts).getTime() / 1000;
}

function getSecondsStr(date) {
  if (!date) {
    return "";
  }

  try {
    return "" + parseInt(date.getTime() / 1000);
  } catch (e) {
    return "";
  }
}

async function digestMessage(message, hashtype) {
  const msgUint8 = new TextEncoder().encode(message);                           // encode as (utf-8) Uint8Array
  const hashBuffer = await crypto.subtle.digest(hashtype, msgUint8);           // hash the message
  const hashArray = Array.from(new Uint8Array(hashBuffer));                     // convert buffer to byte array
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join(''); // convert bytes to hex string
  return hashHex;
}

function makeHeaders(headers) {
  try {
    return new Headers(headers);
  } catch (e) {
    // try to sanitize the headers, if any errors
    for (let key of Object.keys(headers)) {
      const value = headers[key];
      const newValue = value.replace(/[\r\n]+/g, ', ');
      if (value != newValue) {
        headers[key] = newValue;
      }
    }
    return new Headers(headers)
  }
}

function makeRwResponse(content, response, headers) {
  const initOpt = {
    "status": response.status,
    "statusText": response.statusText,
    "headers": headers || response.headers
  };

  return makeNewResponse(content, initOpt, response.timestamp, response.date);
}

const NULL_STATUS = [101, 204, 205, 304];

function makeNewResponse(content, initOpt, timestamp, datestr) {
  if (initOpt && initOpt.status && NULL_STATUS.includes(initOpt.status)) {
    content = null;
  }

  const response = new Response(content, initOpt);
  response.timestamp = timestamp;
  response.date = (datestr.getDate ? datestr : new Date(datestr));
  return response;
}

function isAjaxRequest(request) {
  return request.headers.get('X-Pywb-Requested-With') === 'XMLHttpRequest';
}

function notFound(request, msg) {
  let content;
  let contentType;

  if (!msg) {
    msg = "URL not found";
  }

  if (request.destination === "script" || request.headers.get("x-pywb-requested-with")) {
    content = JSON.stringify(msg);
    contentType = "application/json";
  } else {
    content = msg;
    contentType = "text/html";
  }

  //console.log(`Not Found ${request.destination} - ${msg}`);

  const initOpt = {
    "status": 404,
    "statusText": "Not Found",
    "headers": { "Content-Type": contentType }
  };

  return new Response(content, initOpt);
}

async function makeRangeResponse(response, range) {
  const bytes = range.match(/^bytes\=(\d+)\-(\d+)?$/);

  const arrayBuffer = await response.arrayBuffer();

  if (bytes) {
    const start = Number(bytes[1]);
    const end = Number(bytes[2]) || arrayBuffer.byteLength - 1;
    const headers = response.headers;
    headers.append('Content-Range', `bytes ${start}-${end}/${arrayBuffer.byteLength}`);
    headers.set('Content-Length', end - start + 1);
    return new Response(arrayBuffer.slice(start, end + 1), {
      status: 206,
      statusText: 'Partial Content',
      headers: headers,
    });
  } else {
    return new Response(null, {
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers: [['Content-Range', `*/${arrayBuffer.byteLength}`]]
    });
  }
}

export { startsWithAny, getTS, tsToDate, tsToSec, getSecondsStr, digestMessage,
         makeRwResponse, makeNewResponse, makeHeaders, notFound, makeRangeResponse, isAjaxRequest };
