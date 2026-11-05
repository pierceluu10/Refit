# Excerpt of leedtan/chattutorial at c6122c20bb73, chatbots.py, seen in P5.
    def get_latest_finetuned_model(self):
        """
        Get the latest fine-tuned model from OpenAI's API.
        Messy for now due to hacks I'm putting in as we debug and measure and iterate on measuring data prep practices
        """
        fine_tunes = self.openai.client.fine_tuning.jobs.list()
        winner = None
        for job in fine_tunes.data:
            if job.status == "succeeded":
                file_id = job.training_file
                file_details = self.openai.files.retrieve(file_id)
                winner = job.fine_tuned_model
                if file_details.filename in [
                    "squad_for_openai_chat_clip.jsonl",
                    "squad_for_openai_raw.jsonl",
                ]:
                    return winner
        if winner is not None:
            return winner
        return "no fine tuned models found"

    def generate_response(self, message: str, conversation_history: list) -> str:
        response = self.openai.chat.completions.create(
            model=self.model_name,
            messages=conversation_history,
            max_tokens=3000,
            stop=None,
            temperature=0.0,
        )
        return response.choices[0].message.content


