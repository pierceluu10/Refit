// Excerpt of mantou132/Spotify-Lyrics at 1380002c0830, src/common/ga.ts.
// https://developers.google.com/analytics/devguides/collection/protocol/v1/devguide
const postReq = (params: Record<string, string>) => {
  const uri = 'https://www.google-analytics.com/collect';
  const options: RequestInit = {
    method: 'post',
    body: new URLSearchParams(params).toString(),
  };
  if (isWebApp) {
    const data: Req = { reqId: -1, uri, options };
    window.postMessage({ type: Event.SEND_REQUEST, data }, '*');
  } else {
    fetch(uri, options);
  }
};

const gaRequiredPayload = {
  v: '1', // protocol version
  tid: isProd ? 'UA-163443161-1' : 'UA-88601817-2', // measurement id
};
