---
provider: upgrades
kind: specific
reviewed: false
drafted: 2026-11-06
sources:
  - https://docs.djangoproject.com/en/stable/howto/upgrade-version/
  - https://www.djangoproject.com/download/
  - https://docs.djangoproject.com/en/dev/internals/release-process/
  - https://docs.djangoproject.com/en/dev/internals/deprecation/
  - https://docs.djangoproject.com/en/stable/faq/install/
  - https://docs.djangoproject.com/en/stable/releases/5.2/
  - https://docs.djangoproject.com/en/stable/releases/6.0/
---

# Django upgrades

**Choosing a target.** The [download page](https://www.djangoproject.com/download/) lists 5.2 LTS with extended support until April 2028, 6.0 until April 2027 and 6.1 until December 2027. Planned 6.2 LTS is the last under the old policy; from "Django 2028" every feature release [gets three years](https://docs.djangoproject.com/en/dev/internals/release-process/). `end_of_life` gives the current view. Python is linked: [5.2 takes 3.10 to 3.14, and 6.0 takes 3.12 to 3.14](https://docs.djangoproject.com/en/stable/faq/install/), so a Python bump may have to come along.

**How Django suggests doing it.** The [upgrade guide](https://docs.djangoproject.com/en/stable/howto/upgrade-version/) says to read the release notes for each final release between your version and the target, plus the [deprecation timeline](https://docs.djangoproject.com/en/dev/internals/deprecation/). It also recommends going through each feature release incrementally, on its latest patch, and clearing deprecation warnings first. They're silenced by default, so run `python -Wa manage.py test`. Passing through intermediate versions in the sandbox still gives you a single PR at the end.

**What usually breaks.**

- Deprecated features removed on schedule; a feature deprecated in A.x works through that series, then goes.
- Silent defaults. [`DEFAULT_AUTO_FIELD` defaults to `BigAutoField` in 6.0](https://docs.djangoproject.com/en/stable/releases/6.0/). A project without the setting will get new migrations, and possibly table rewrites, for its primary keys. Set the old value explicitly unless the task is to change it, and tell a person either way.
- Database floors. [5.2 needs PostgreSQL 14 or later](https://docs.djangoproject.com/en/stable/releases/5.2/), and changes the MySQL connection charset default to `utf8mb4`. Tests on SQLite won't show these.
- Email: 6.0 changed the internals of `EmailMessage` and `EmailMultiAlternatives`, so custom subclasses need reading.
- Third-party apps. The guide warns they may lag a new release; `registry_diff` shows their declared compatibility.

**How to spot it.** Grep for names in each release's "Backwards incompatible changes" and removal sections. Read custom database backends, model fields, middleware, `settings.py`, and anything subclassing Django internals. Each [release's notes](https://docs.djangoproject.com/en/stable/releases/6.0/) name what it changed for third-party backends.

**What to check.** `python manage.py check`, `python manage.py makemigrations --check` to catch unexpected migrations, and `migrate` on a test database as well as tests. `migration_guide` gathers the notes; `codemod` lists known helpers. Django's guide points to automated helpers on its community ecosystem page. Treat those as community tools and read their diff.

**Pitfalls.**

- A generated migration is a production data change. Never leave one in the PR without calling it out.
- Pinned `django-*` packages in `requirements*.txt` that cap the Django version.
- Test settings that differ from production's database.
