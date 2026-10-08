import { createAuthClient } from "better-auth/vue";
import { baseURL } from "./app.ts";

// Vite serves its own HTML during development, without the backend's injected config.
if (import.meta.env.DEV) {
    const response = await fetch(baseURL + "/api/app-config");
    if (!response.ok) {
        throw new Error("Uygulama yapılandırması alınamadı.");
    }
    const config = await response.json();
    window.isLocalMode = config.isLocalMode === true;
    window.isDemo = config.isDemo === true;
}

export const isLocalMode = window.isLocalMode === true;

export const authClient = createAuthClient({
    baseURL: baseURL,
});

export async function isLoggedIn() {
    if (isLocalMode) {
        return true;
    }

    const session = await authClient.getSession();
    return session.data !== null;
}
