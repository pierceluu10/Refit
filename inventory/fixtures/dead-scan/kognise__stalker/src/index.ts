// Excerpt of kognise/stalker at 152fa25afa8c, src/index.ts, seen in P5.
		async (req, reply) => {
			if (req.headers.authorization !== env.zoomVerificationToken) {
				reply.status(401)
				throw new Error('Invalid verification token')
			}
			if (req.body.event === 'user.presence_status_updated') {
