# Excerpt of konan-ny/MAF2024 at 51c679259fd4, metric/latte/get_bias_score.py, seen in P5.
import os
import sys
import pandas as pd
import re
from transformers import pipeline, AutoTokenizer
from tqdm import tqdm

parent_dir = os.environ["PYTHONPATH"]
data_dir = parent_dir + "/MAF2024/data/latte"


class GetBiasScore:
    def __init__(
        self,
        target: str = "gpt4o",
        data_dir: str = data_dir,
        model_name="gpt-4o-2024-05-13",
    ):
        self.threshold = 0.3
        self.model_name = model_name
        self.response_dir = data_dir + "/" + model_name
        self.load_and_preprocess_data(data_dir)
        deon_response = pd.read_csv(
            f"{self.response_dir}/Ethics_deon_gpt-4o-2024-05-13.csv"
        )
        deon_response = deon_response.applymap(lambda x: str(x).strip(".").strip())
        self.deon_response = deon_response.applymap(lambda x: 0 if x == "No" else 1)
