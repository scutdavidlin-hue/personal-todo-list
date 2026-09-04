import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePublishableApiKey,
  resolveServiceApiKey,
  serviceApiHeaders,
} from "../supabase/functions/_shared/supabase-api-keys.js";

test("new named secret key takes precedence over the legacy service-role key", () => {
  assert.equal(resolveServiceApiKey({
    secretKeys: JSON.stringify({ default: "sb_secret_current" }),
    serviceRoleKey: "legacy-service-role",
    preferNew: true,
  }), "sb_secret_current");
});

test("legacy service-role remains the default until migration is explicitly enabled", () => {
  assert.equal(resolveServiceApiKey({
    secretKeys: JSON.stringify({ default: "sb_secret_current" }),
    serviceRoleKey: "legacy-service-role",
  }), "legacy-service-role");
});

test("legacy service-role key remains a safe migration fallback", () => {
  assert.equal(resolveServiceApiKey({
    secretKeys: "not-json",
    serviceRoleKey: "legacy-service-role",
  }), "legacy-service-role");
});

test("publishable key takes precedence over the legacy anon key", () => {
  assert.equal(resolvePublishableApiKey({
    publishableKeys: JSON.stringify({ default: "sb_publishable_current" }),
    anonKey: "legacy-anon",
    preferNew: true,
  }), "sb_publishable_current");
});

test("new secret key is sent only as apikey", () => {
  assert.deepEqual(serviceApiHeaders("sb_secret_current"), {
    apikey: "sb_secret_current",
  });
});

test("legacy service-role key retains its Bearer header", () => {
  assert.deepEqual(serviceApiHeaders("legacy-service-role"), {
    apikey: "legacy-service-role",
    Authorization: "Bearer legacy-service-role",
  });
});
