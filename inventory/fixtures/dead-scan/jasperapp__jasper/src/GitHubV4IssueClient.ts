// Excerpt of jasperapp/jasper, src/Renderer/Library/GitHub/V4/GitHubV4IssueClient.ts, seen in P5.
import { post } from './GitHubV4Client';

export const fetchIssues = (ids: string) => post(GITHUB_QUERY_TEMPLATE.replace('__NODE_IDS__', ids));

// timelineのPullRequestCommit(pushedDate)はissue.updatedAtよりも古い
const GITHUB_QUERY_TEMPLATE = `
nodes(ids: [__NODE_IDS__]) {
  ... on PullRequest {
    timelineItems(last: 1) {
      nodes {
        ... on PullRequestCommit {__typename commit {pushedDate committedDate authoredDate author {user {login}}}}
        ... on PullRequestRevisionMarker {__typename  lastSeenCommit {pushedDate committedDate authoredDate}}
      }
    }
  }
}`;
