import { requireAdmin } from '../../_lib/admin-auth.js';
import { handleApiError, json } from '../../_lib/http.js';

export async function onRequestGet(context) {
  try {
    const { identity, user } = await requireAdmin(context);
    return json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      authSource: identity.source,
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return handleApiError(error);
  }
}
