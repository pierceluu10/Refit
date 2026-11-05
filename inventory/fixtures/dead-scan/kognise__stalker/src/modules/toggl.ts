// Excerpt of kognise/stalker at 152fa25afa8c, src/modules/toggl.ts, seen in P5.
export const getTogglState = async (): Promise<TogglState> => {
	const res = await fetch('https://api.track.toggl.com/api/v8/time_entries/current', {
		headers: {
			Authorization: `Basic ${Buffer.from(`${env.togglApiKey}:api_token`).toString('base64')}`
		}
	})
	if (!res.ok) throw new Error(`Status ${res.status} while fetching Toggl current entry`)
	const json = (await res.json()) as TogglCurrentEntry
