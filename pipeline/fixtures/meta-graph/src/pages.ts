import axios from 'axios';
import { GRAPH_BASE, graphGet } from './shared/graph.js';

const API = GRAPH_BASE;

export async function pages(token: string) {
  return graphGet(`${API}/me/accounts?fields=id,name,access_token&access_token=${token}`);
}

export async function page(pageId: string, token: string) {
  const response = await axios.get(`https://graph.facebook.com/v18.0/${pageId}`, {
    params: { fields: 'name,instagram_business_account{id,username}', access_token: token },
  });
  return response.data;
}

export async function publish(pageId: string, token: string, message: string) {
  const url = `https://graph.facebook.com/v18.0/${pageId}/feed`;
  return axios.post(url, { message, access_token: token });
}

export async function insights(mediaId: string, token: string) {
  const params = new URLSearchParams({
    metric: 'reach,saved',
    access_token: token,
  });
  return fetch(`https://graph.facebook.com/v18.0/${mediaId}/insights?${params}`);
}

export async function comments(postId: string, token: string, fields: string) {
  // fetch(`https://graph.facebook.com/v17.0/${postId}/comments`) is the old call.
  return fetch(
    `https://graph.facebook.com/v18.0/${postId}/comments?fields=${fields}&access_token=${token}`,
  );
}

export async function edge(nodeId: string, name: string, version: string) {
  return fetch(`https://graph.facebook.com/${version}/${nodeId}/${name}`);
}

export async function me(token: string) {
  return fetch('https://graph.facebook.com/me?fields=id%2Cname&access_token=' + token);
}
