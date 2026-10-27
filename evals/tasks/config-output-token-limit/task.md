Implement persistent configuration for the maximum model output token limit.

Add maxOutputTokens to loadConfig() and saveConfig(). It should default to 8192, clamp values to 1024 through 131072 on both load and save, and be available as config.maxOutputTokens after loading. Keep all existing provider URL and credential protections unchanged.
