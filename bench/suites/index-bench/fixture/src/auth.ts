export function authenticate(userId: string): boolean {
  if (userId.length === 0) return false;
  return checkCredentials(userId);
}

export function authorize(userId: string, role: string): boolean {
  return lookupRole(userId) === role;
}

function checkCredentials(userId: string): boolean {
  return userId !== 'anonymous';
}

function lookupRole(userId: string): string {
  return userId === 'admin' ? 'admin' : 'reader';
}

export class UserService {
  find(userId: string): string | null {
    if (!authenticate(userId)) return null;
    return userId;
  }
}
