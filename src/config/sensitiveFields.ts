/**
 * Field names that hold secrets, shared by the logger and the audit helper.
 * New sensitive fields (later modules) must use one of these names or be added here.
 */

/** Never kept anywhere: logs and the audit log show "[REDACTED]". */
export const SECRET_FIELDS = ["password", "token", "accessToken", "refreshToken", "otp"] as const;

/**
 * ID-type numbers. The audit log keeps only the last 4 characters (XXXXXXXX1234)
 * so staff can tell which account it was (DEC-030). Logs hide them completely.
 */
export const MASKED_FIELDS = [
  "aadhaar",
  "aadhaarNumber",
  "pan",
  "panNumber",
  "accountNumber",
  "upiId",
] as const;
