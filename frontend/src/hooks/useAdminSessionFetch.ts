import { useCallback } from "react";

import { fetchWithAdminCredentials, loginAdmin } from "../api/client";
import { getErrorMessage } from "../utils";

type AddLog = (message: string) => void;

export function useAdminSessionFetch(addAutopilotLog: AddLog) {
  const loginWithPrompt = useCallback(async (): Promise<boolean> => {
    const password = window.prompt("Admin password");

    if (!password) {
      addAutopilotLog("Admin login cancelled.");
      return false;
    }

    try {
      await loginAdmin(password);

      addAutopilotLog("Admin session established.");
      return true;
    } catch (error) {
      addAutopilotLog(`Admin login failed: ${getErrorMessage(error)}`);
      return false;
    }
  }, [addAutopilotLog]);

  return useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      let response = await fetchWithAdminCredentials(path, init);

      if (response.status !== 401) {
        return response;
      }

      addAutopilotLog("Admin session required.");
      const loggedIn = await loginWithPrompt();

      if (!loggedIn) {
        return response;
      }

      response = await fetchWithAdminCredentials(path, init);

      return response;
    },
    [addAutopilotLog, loginWithPrompt],
  );
}
