import { getAndRefreshToken, makeApiCall } from '../api-caller.js';
const GITHUB_API_BASE = 'https://api.github.com';
export async function listRepos(userId) {
    const token = await getAndRefreshToken(userId, 'github');
    if (!token)
        throw new Error('GitHub not connected');
    return makeApiCall(`${GITHUB_API_BASE}/user/repos?per_page=50&sort=updated`, {
        authorization: `Bearer ${token.accessToken}`,
        headers: { 'X-GitHub-Api-Version': '2022-11-28' }
    });
}
export async function createIssue(userId, owner, repo, title, body) {
    const token = await getAndRefreshToken(userId, 'github');
    if (!token)
        throw new Error('GitHub not connected');
    return makeApiCall(`${GITHUB_API_BASE}/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        authorization: `Bearer ${token.accessToken}`,
        headers: { 'X-GitHub-Api-Version': '2022-11-28' },
        body: { title, body }
    });
}
export async function listIssues(userId, owner, repo, state = 'open') {
    const token = await getAndRefreshToken(userId, 'github');
    if (!token)
        throw new Error('GitHub not connected');
    return makeApiCall(`${GITHUB_API_BASE}/repos/${owner}/${repo}/issues?state=${state}&per_page=50`, {
        authorization: `Bearer ${token.accessToken}`,
        headers: { 'X-GitHub-Api-Version': '2022-11-28' }
    });
}
export async function getIssue(userId, owner, repo, issueNumber) {
    const token = await getAndRefreshToken(userId, 'github');
    if (!token)
        throw new Error('GitHub not connected');
    return makeApiCall(`${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}`, {
        authorization: `Bearer ${token.accessToken}`,
        headers: { 'X-GitHub-Api-Version': '2022-11-28' }
    });
}
export async function addCommentToIssue(userId, owner, repo, issueNumber, body) {
    const token = await getAndRefreshToken(userId, 'github');
    if (!token)
        throw new Error('GitHub not connected');
    return makeApiCall(`${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
        method: 'POST',
        authorization: `Bearer ${token.accessToken}`,
        headers: { 'X-GitHub-Api-Version': '2022-11-28' },
        body: { body }
    });
}
export async function getUser(userId) {
    const token = await getAndRefreshToken(userId, 'github');
    if (!token)
        throw new Error('GitHub not connected');
    return makeApiCall(`${GITHUB_API_BASE}/user`, {
        authorization: `Bearer ${token.accessToken}`,
        headers: { 'X-GitHub-Api-Version': '2022-11-28' }
    });
}
