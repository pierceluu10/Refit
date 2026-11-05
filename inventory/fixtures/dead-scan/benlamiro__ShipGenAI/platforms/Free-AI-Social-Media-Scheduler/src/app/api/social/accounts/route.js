// Excerpt of benlamiro/ShipGenAI at 10037d3d3fcf, platforms/Free-AI-Social-Media-Scheduler/src/app/api/social/accounts/route.js, seen in P5.
    // 2. Fetch first-party accounts (connected under the developer's key, e.g. TikTok)
    try {
      const devRes = await fetch("https://api.muapi.ai/api/social/accounts", {
        headers: { "x-api-key": apiKey }
      });
      if (devRes.ok) {
