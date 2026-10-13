# Models

## owned_by

The Model object returned by models.retrieve includes owned_by, the organization that owns the model. Refit's OpenAI fixture simulates removing owned_by and adding owner_name. That replacement is synthetic and is not an announced OpenAI rename. A grounded patch for this fixture reads owner_name only where the operator mapping says the new field replaces owned_by.
