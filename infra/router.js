function handler(event) {
  var request = event.request;
  var domain = __PREVIEW_DOMAIN__;
  var host = request.headers.host && request.headers.host.value;
  var suffix = '.' + domain;
  var forbidden = {
    statusCode: 403,
    statusDescription: 'Forbidden',
    headers: { 'cache-control': { value: 'no-store' } },
  };

  if (!host || !host.endsWith(suffix)) {
    return forbidden;
  }
  var branch = host.slice(0, -suffix.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(branch)) {
    return forbidden;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return forbidden;
  }

  var uri = request.uri;
  if (!uri.startsWith('/') || /[\\\x00-\x20\x7f?#]/.test(uri) || /%(?:2f|5c|25)/i.test(uri)) {
    return forbidden;
  }
  var decoded;
  try {
    decoded = decodeURIComponent(uri);
  } catch (error) {
    return forbidden;
  }
  if (/[\\\x00-\x1f\x7f]/.test(decoded) || decoded.includes('//')) {
    return forbidden;
  }
  var segments = decoded.split('/');
  if (segments.some(function (segment) { return segment === '.' || segment === '..'; }) || segments[1] === '_control') {
    return forbidden;
  }

  var accept = request.headers.accept && request.headers.accept.value;
  var destination = request.headers['sec-fetch-dest'] && request.headers['sec-fetch-dest'].value;
  var isNavigation = accept && accept.includes('text/html') && (!destination || destination === 'document');
  var isStatic = segments[1] === 'assets' || segments[1] === 'data' || segments[1] === 'static';
  var lastSegment = segments[segments.length - 1];
  if (uri === '/' || (isNavigation && !isStatic && !lastSegment.includes('.'))) {
    uri = '/index.html';
  }
  request.uri = '/' + branch + uri;
  return request;
}
