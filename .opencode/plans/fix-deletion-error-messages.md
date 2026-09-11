# Fix: surface real server errors in the user-deletion OTP flow

## Problem
When deleting a user, the SettingsPage toast shows the generic axios message
("Request failed with status code 400/500") instead of the real server error
(e.g. "Current password required", "Target user has no email address").

Root cause: `client.ts` interceptor re-throws the raw `AxiosError`; the
SettingsPage catch blocks use `err.message` (the axios wrapper text) rather
than `err.response.data.message`.

## Files to change

### `src/pages/SettingsPage.tsx`
1. Add import (already planned but blocked by permission rules):
   `import { isAxiosError } from "axios";`
2. Add helper near the top of the file:

   ```ts
   const getApiError = (err: unknown): string => {
     if (isAxiosError(err)) return err.response?.data?.message ?? err.message;
     return err instanceof Error ? err.message : "An unexpected error occurred";
   };
   ```

3. Update `handleRequestDeletion` catch (line ~444):
   `showToast(err.message, "error")` -> `showToast(getApiError(err), "error")`
4. Update `handleVerifyDeletion` catch (line ~468):
   `showToast(err.message, "error")` -> `showToast(getApiError(err), "error")`

## Verification steps (after edits are allowed)
- `rtk npm run build` (tsc + vite) must pass
- `node --check server.cjs` must pass
- Optional: `npm run dev`, delete a user -> the toast should now say the real
  reason (e.g. "Incorrect password", "Confirmation code generated (dev mode...)").

## Note
SMTP setup is NOT required for deletion in dev. Without SMTP_HOST, the OTP is
printed to the server console and the flow uses the dev-fallback path.