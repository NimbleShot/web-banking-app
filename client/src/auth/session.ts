// The access token lives in sessionStorage: it survives a reload and ends with the tab.
const TOKEN_KEY = 'bank.accessToken';

export function saveToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function readToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}
