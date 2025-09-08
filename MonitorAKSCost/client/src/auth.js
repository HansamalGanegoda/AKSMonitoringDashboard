import { PublicClientApplication, EventType } from '@azure/msal-browser';

// Configure with your SPA app registration values
const clientId = process.env.REACT_APP_AZURE_AD_CLIENT_ID || '<REPLACE_CLIENT_ID>';
const tenantId = process.env.REACT_APP_AZURE_AD_TENANT_ID || '<REPLACE_TENANT_ID>';
const authority = `https://login.microsoftonline.com/${tenantId}`;

export const msalInstance = new PublicClientApplication({
  auth: {
    clientId,
    authority,
    redirectUri: '/',
  },
  cache: { cacheLocation: 'localStorage', storeAuthStateInCookie: false }
});

msalInstance.addEventCallback(e => {
  if (e.eventType === EventType.LOGIN_SUCCESS && e.payload?.account) {
    msalInstance.setActiveAccount(e.payload.account);
  }
});

export async function loginInteractive() {
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length) {
    msalInstance.setActiveAccount(accounts[0]);
    return accounts[0];
  }
  const res = await msalInstance.loginPopup({ scopes:[ 'https://management.azure.com/.default' ] });
  msalInstance.setActiveAccount(res.account);
  return res.account;
}

export async function acquireArmToken() {
  const account = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
  if (!account) throw new Error('Not logged in');
  try {
    const silent = await msalInstance.acquireTokenSilent({ account, scopes:['https://management.azure.com/.default'] });
    return silent.accessToken;
  } catch {
    const interactive = await msalInstance.acquireTokenPopup({ account, scopes:['https://management.azure.com/.default'] });
    return interactive.accessToken;
  }
}

export function logout() { msalInstance.logoutPopup(); }