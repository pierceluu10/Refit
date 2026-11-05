// Excerpt of benlamiro/ShipGenAI at 10037d3d3fcf, platforms/Free-AI-Social-Media-Scheduler/src/app/api/social/accounts/[id]/route.js, seen in P5.
    }

    const res = await fetch(`https://api.muapi.ai/api/social/accounts/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
