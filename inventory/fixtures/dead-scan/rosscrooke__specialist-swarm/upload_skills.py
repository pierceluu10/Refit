# Excerpt of rosscrooke/specialist-swarm, upload_skills.py, seen in P5.
import anthropic
from anthropic.lib import files_from_dir

client = anthropic.Anthropic()


def main():
    existing_by_title = {}
    for page in client.beta.skills.list(source="custom"):
        existing_by_title[page.display_title] = page.id

    display_title = "Scheduler"
    if display_title not in existing_by_title:
        client.beta.skills.create(
            display_title=display_title,
            files=files_from_dir("skills/scheduler"),
        )


if __name__ == "__main__":
    main()
