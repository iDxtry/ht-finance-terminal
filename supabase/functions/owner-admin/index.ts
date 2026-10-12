import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const allowedOrigins = new Set([
  'https://ht-finance-terminal.vercel.app',
  'https://idxtry.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

const responseHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json',
  'Vary': 'Origin',
};

const roles = new Set(['owner', 'manager', 'intern', 'quant']);
const maxBodyBytes = 8 * 1024;
const authUsersPerPage = 100;
const maxAuthPages = 100;

function jsonResponse(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...responseHeaders, 'Access-Control-Allow-Origin': origin },
  });
}

function jsonError(error: string, status: number, origin: string, code?: string) {
  return jsonResponse({ ok: false, error, ...(code ? { code } : {}) }, status, origin);
}

function validEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const email = value.trim();
  if (email.length < 3 || email.length > 254 || /[\r\n\s]/.test(email)) return false;
  const parts = email.split('@');
  if (parts.length !== 2 || parts[0].length > 64 || parts[1].length > 253) return false;
  return /^[^@.][^@]*@[^@.]+(?:\.[^@.]+)+$/.test(email);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

Deno.serve(async (request) => {
  const origin = request.headers.get('Origin') || '';
  if (!allowedOrigins.has(origin)) {
    return new Response('Origin not allowed', { status: 403 });
  }

  if (request.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { ...responseHeaders, 'Access-Control-Allow-Origin': origin },
    });
  }
  if (request.method !== 'POST') {
    return jsonError('Use a POST request.', 405, origin, 'METHOD_NOT_ALLOWED');
  }

  const authorization = request.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    return jsonError('Sign in with an approved club account to continue.', 401, origin, 'AUTH_REQUIRED');
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) {
    return jsonError('The club admin service is not configured.', 503, origin, 'SERVICE_UNAVAILABLE');
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return jsonError('Request body could not be read.', 400, origin, 'INVALID_BODY');
  }
  if (new TextEncoder().encode(bodyText).byteLength > maxBodyBytes) {
    return jsonError('Request body is too large.', 413, origin, 'BODY_TOO_LARGE');
  }

  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!isRecord(parsed)) throw new Error('Expected an object.');
    input = parsed;
  } catch {
    return jsonError('Request body must be a JSON object.', 400, origin, 'INVALID_BODY');
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { data: authData, error: authError } = await userClient.auth.getUser();
    const caller = authData.user;
    if (authError || !caller) {
      return jsonError('Your session expired. Sign in again.', 401, origin, 'SESSION_EXPIRED');
    }

    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!serviceRoleKey) {
      return jsonError('The secure admin service is not configured.', 503, origin, 'SERVICE_UNAVAILABLE');
    }
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    if (input.action === 'bootstrap') {
      const initialOwnerEmail = Deno.env.get('INITIAL_OWNER_EMAIL')?.trim();
      const callerEmail = caller.email?.trim();
      if (!initialOwnerEmail) {
        return jsonError('Initial Owner setup is not enabled for this project.', 503, origin, 'BOOTSTRAP_DISABLED');
      }
      if (!callerEmail || !caller.email_confirmed_at) {
        return jsonError('A verified email address is required for Initial Owner setup.', 403, origin, 'VERIFIED_EMAIL_REQUIRED');
      }
      if (callerEmail.toLowerCase() !== initialOwnerEmail.toLowerCase()) {
        return jsonError('This account is not eligible for Initial Owner setup.', 403, origin, 'BOOTSTRAP_NOT_ALLOWED');
      }

      // This RPC is service-role-only. It performs the no-active-Owner check and
      // assignment atomically, so simultaneous bootstrap requests cannot create two Owners.
      const { error } = await adminClient.rpc('bootstrap_initial_owner', {
        target_user_id: caller.id,
      });
      if (error) {
        return jsonError(
          'Initial Owner setup is no longer available. An active Owner may already exist, or the account is not eligible.',
          409,
          origin,
          'BOOTSTRAP_UNAVAILABLE',
        );
      }
      return jsonResponse({ ok: true, role: 'owner' }, 200, origin);
    }

    if (input.action !== 'invite') {
      return jsonError('Choose a supported admin action.', 400, origin, 'UNKNOWN_ACTION');
    }

    const rawEmail = input.email;
    const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
    const role = input.role;
    if (!validEmail(email)) {
      return jsonError('Enter a valid email address.', 400, origin, 'INVALID_EMAIL');
    }
    if (typeof role !== 'string' || !roles.has(role)) {
      return jsonError('Choose Owner, Manager, Intern, or Quant.', 400, origin, 'INVALID_ROLE');
    }

    const { data: callerIsOwner, error: ownerError } = await userClient.rpc('is_owner');
    if (ownerError) {
      return jsonError('Owner permissions could not be verified. Try again later.', 503, origin, 'OWNER_CHECK_FAILED');
    }
    if (callerIsOwner !== true) {
      return jsonError('Only an active Owner can invite or assign club members.', 403, origin, 'OWNER_REQUIRED');
    }

    const { data: canManageMembers, error: permissionError } = await userClient.rpc('has_permission', {
      permission_key: 'members.manage',
    });
    if (permissionError) {
      return jsonError('Member permissions could not be verified. Try again later.', 503, origin, 'PERMISSION_CHECK_FAILED');
    }
    if (canManageMembers !== true) {
      return jsonError('You do not have permission to invite club members.', 403, origin, 'FORBIDDEN');
    }

    let targetUser: { id: string } | null = null;
    let authPage = 1;
    let authDirectoryComplete = false;
    while (authPage <= maxAuthPages) {
      const { data: usersData, error: usersError } = await adminClient.auth.admin.listUsers({
        page: authPage,
        perPage: authUsersPerPage,
      });
      if (usersError) {
        return jsonError('Existing accounts could not be checked. Try again later.', 503, origin, 'ACCOUNT_LOOKUP_FAILED');
      }

      targetUser = usersData.users.find((user) => user.email?.toLowerCase() === email.toLowerCase()) || null;
      if (targetUser) break;
      if (usersData.users.length < authUsersPerPage || usersData.nextPage === null) {
        authDirectoryComplete = true;
        break;
      }
      authPage = typeof usersData.nextPage === 'number' ? usersData.nextPage : authPage + 1;
    }

    let invited = false;
    if (!targetUser) {
      if (!authDirectoryComplete) {
        return jsonError('The account directory is too large to verify safely. Contact the platform administrator.', 503, origin, 'ACCOUNT_LOOKUP_INCOMPLETE');
      }
      const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email);
      if (inviteError || !inviteData.user) {
        const providerStatus = Number((inviteError as { status?: unknown } | null)?.status);
        if (providerStatus === 409 || providerStatus === 422) {
          return jsonError('That email already has an account or pending invitation. Refresh the member list and try again.', 409, origin, 'INVITATION_EXISTS');
        }
        return jsonError('The invitation could not be sent. Check the email address and try again.', 502, origin, 'INVITATION_FAILED');
      }
      targetUser = inviteData.user;
      invited = true;
    }

    const { error: assignmentError } = await adminClient.rpc('assign_invited_member', {
      target_user_id: targetUser.id,
      assigned_role: role,
      owner_user_id: caller.id,
    });
    if (assignmentError) {
      // Do not delete an Auth account implicitly; the role assignment may be
      // retried after the Owner reviews the member list.
      return jsonError(
        invited
          ? 'The invitation was sent, but the club role could not be assigned. Review the member list before inviting again.'
          : 'The account was found, but the club role could not be assigned. Review the member list and try again.',
        502,
        origin,
        'ROLE_ASSIGNMENT_FAILED',
      );
    }

    return jsonResponse({ ok: true, invited, assigned: true, role }, 200, origin);
  } catch {
    // Avoid returning database, provider, or credential details to the browser.
    return jsonError('The admin request could not be completed. Try again later.', 500, origin, 'ADMIN_REQUEST_FAILED');
  }
});
