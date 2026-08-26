/**
 * Logging out must not be able to fail.
 *
 * A rejected logout is not a cosmetic 400: the controller aborts before the
 * fcmToken is unregistered, so the device stays subscribed and a logged-out
 * user keeps receiving push notifications. These cases are the shapes real
 * clients were observed sending -- a null token, and no token field at all.
 *
 * Run: node src/modules/quickCommerce/dtos/auth/__checks__/logout.check.js
 */
import { validateLogoutDto } from '../logout.dto.js';

let failures = 0;

const accepts = (label, body) => {
    try {
        const parsed = validateLogoutDto(body);
        console.log(`  PASS  ${label}`);
        return parsed;
    } catch (error) {
        failures += 1;
        console.log(`  FAIL  ${label} -- rejected with: ${error.message}`);
        return null;
    }
};

const rejects = (label, body) => {
    try {
        validateLogoutDto(body);
        failures += 1;
        console.log(`  FAIL  ${label} -- was accepted but should not be`);
    } catch {
        console.log(`  PASS  ${label}`);
    }
};

// The two shapes that were returning 400 in production.
accepts('null refreshToken is accepted', { refreshToken: null });
accepts('missing refreshToken is accepted', {});
accepts('undefined refreshToken is accepted', { refreshToken: undefined });

// The FCM token must survive parsing, because detaching it is the part of
// logout that still has to happen when there is no refresh token.
const withFcm = accepts('null refreshToken keeps fcmToken', {
    refreshToken: null,
    fcmToken: 'device-token-abc',
    platform: 'mobile',
});
if (withFcm && withFcm.fcmToken !== 'device-token-abc') {
    failures += 1;
    console.log(`  FAIL  fcmToken was dropped: got ${JSON.stringify(withFcm.fcmToken)}`);
} else if (withFcm) {
    console.log('  PASS  fcmToken preserved for detachment');
}

// A real token still parses.
const normal = accepts('a real refreshToken is accepted', { refreshToken: 'abc123' });
if (normal && normal.refreshToken !== 'abc123') {
    failures += 1;
    console.log('  FAIL  refreshToken was not returned intact');
}

// Absence is fine; a present-but-empty string is still a client bug worth
// surfacing, so the min(1) is intentionally kept.
rejects('empty-string refreshToken is still rejected', { refreshToken: '' });
rejects('a non-string refreshToken is still rejected', { refreshToken: 42 });

console.log(failures ? `\n${failures} FAILED` : '\nall logout DTO checks passed');
process.exit(failures ? 1 : 0);
