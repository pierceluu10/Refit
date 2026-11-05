// Excerpt of hridoyhossain1001/buykori-client-portal at 73db26d64aee, src/lib/mock-data.ts.
  return events.map(evt => {
    const urls: Record<CAPIEvent['platform'], string> = {
      'Meta CAPI': 'https://graph.facebook.com/v18.0/pixel_id/events',
      'TikTok Events API': 'https://open-api.tiktok.com/v1.3/pixel/track',
      'GA4': 'https://www.google-analytics.com/mp/collect?api_secret=sec_key&measurement_id=id',
      'TikTok Browser Pixel': 'Browser pixel',
      'Gateway Ingest': '/api/events',
    };

    return {
