# Excerpt of bcrant/Tableau2Slack, Tableau2Slack.py, seen in P5.
import tableauserverclient as TSC
from slack import WebClient


def Tableau2Slack():
    tableau_auth = TSC.TableauAuth(tabAccount, tabPass, tabDomain)
    server = TSC.Server(tabServer)
    sc = WebClient(slackBotToken)
    img = sc.files_upload(channels="#tableau-test", file=tabPath, title=imagetitle)
    return img["file"]["url_private"]


Tableau2Slack()
