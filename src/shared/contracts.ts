export interface Library {
  id: string;
  learnerId: string;
  learnerName: string;
}
export interface Home {
  library: Library;
  account: { id: string; username: string };
  session: { id: string; deviceName: string; expiresAt: number };
}
export interface SessionResult extends Home {
  token: string;
  recoveryCode?: string;
}
export interface ServerInfo {
  app: 'klbook';
  apiVersion: 1;
  initialized: boolean;
}
export interface SetupInput {
  setupCode: string;
  username: string;
  password: string;
  learnerName: string;
  deviceName: string;
}
export interface LoginInput { username: string; password: string; deviceName: string }
export interface RecoveryInput { recoveryCode: string; newPassword: string; deviceName: string }
export interface ParentGrant { token: string; expiresAt: number }
export interface Device { id: string; deviceName: string; createdAt: number; expiresAt: number; current: boolean }
