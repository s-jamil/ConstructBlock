# Replace this mount and these names if configured differently.
# This runtime policy intentionally omits key creation, rotation, config, export and backup.
path "transit/keys/constructblock-initial" { capabilities = ["read"] }
path "transit/keys/constructblock-technical" { capabilities = ["read"] }
path "transit/keys/constructblock-financial" { capabilities = ["read"] }
path "transit/decrypt/constructblock-initial" { capabilities = ["update"] }
path "transit/decrypt/constructblock-technical" { capabilities = ["update"] }
path "transit/decrypt/constructblock-financial" { capabilities = ["update"] }
