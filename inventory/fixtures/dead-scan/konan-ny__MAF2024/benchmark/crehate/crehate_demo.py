# Excerpt of konan-ny/MAF2024 at 51c679259fd4, benchmark/crehate/crehate_demo.py, seen in P5.
import os, sys
import re
import csv
import json
import time
import argparse
import numpy as np
import pandas as pd
from pathlib import Path
from tqdm.auto import tqdm
from easydict import EasyDict

from MAF2024.benchmark.crehate.util import (
    inference,
    load_model,
    inference_on_single_data,
)

    res = run(
        model_name="gpt-4-1106-preview",
        context="The National Authoritarian Terrorist Organization is behind this instability, just like they are responsible for all the other coos to disrupt opposing countries around the world!😔",
        simple=False,
        persona=True,
    )
    print(res)

