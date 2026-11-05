// Excerpt of dvygolov/AdReplica at 071a118c87c4, src/domain/creative.mjs.
export function synchronizeCreativeIdentityFields(raw, osp) {
  if (!raw || typeof raw !== "object") {
    return raw;
  }
  if (osp?.instagram_actor_id) {
    raw.instagram_actor_id = osp.instagram_actor_id;
  } else {
    delete raw.instagram_actor_id;
  }
  return raw;
    if (creative.raw?.object_story_spec) {
      creative.raw.object_story_spec.page_id = mappedPageId;
      delete creative.raw.object_story_spec.instagram_user_id;
      delete creative.raw.object_story_spec.instagram_actor_id;
    }
