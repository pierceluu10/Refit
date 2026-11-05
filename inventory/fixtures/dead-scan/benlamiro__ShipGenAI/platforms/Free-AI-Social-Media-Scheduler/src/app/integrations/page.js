// Excerpt of benlamiro/ShipGenAI at 10037d3d3fcf, platforms/Free-AI-Social-Media-Scheduler/src/app/integrations/page.js, seen in P5.
  useEffect(() => {
    // Fetch interest counts from MuAPI public endpoint
    fetch("https://api.muapi.ai/api/social/integration-interest-counts")
      .then((res) => res.json())
      .then((data) => setInterestCounts(data || {}))
