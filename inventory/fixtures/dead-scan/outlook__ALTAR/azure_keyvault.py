# Excerpt of outlook/ALTAR, azure_keyvault.py, seen in P5.
from azure.common.credentials import ServicePrincipalCredentials
from azure.keyvault import KeyVaultClient
from azure.keyvault.generated.models.key_vault_error import KeyVaultErrorException

client = KeyVaultClient(ServicePrincipalCredentials())
