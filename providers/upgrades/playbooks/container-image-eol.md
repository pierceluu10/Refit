---
provider: upgrades
kind: container-image-eol
reviewed: false
drafted: 2026-11-06
sources:
  - https://docs.docker.com/build/building/best-practices/
  - https://docs.docker.com/reference/dockerfile/
  - https://raw.githubusercontent.com/docker-library/docs/master/node/README.md
  - https://www.debian.org/releases/
---

A base image ages in two ways at once: the language runtime inside it and the OS beneath it. `node:18-bookworm` is two decisions. An old tag usually still pulls long after it stopped getting rebuilds, so the Dockerfile keeps building while its contents go stale.

**What usually breaks.** OS package names and versions in `apt-get` or `apk` lines, glibc versus musl when moving to Alpine, native modules and pre-built binaries, default users and paths, removed system libraries, and CA or OpenSSL behaviour.

**How to spot it in code.** Find every `FROM` in every Dockerfile, including multi-stage builds, `ARG`-driven tags, and `Dockerfile.*` variants. Also check `docker-compose` `image:` lines, Kubernetes manifests, CI `container:` and `services:` keys, and devcontainer config. Note `RUN` lines that install OS packages or `COPY` from a named stage.

**What to check.**

- `docker_image_tags` shows the tags still supported for an image. For official images, the [supported tags list](https://raw.githubusercontent.com/docker-library/docs/master/node/README.md) is the best signal that a tag still gets rebuilt.
- `end_of_life` covers the runtime and the OS version. Debian's [release page](https://www.debian.org/releases/) gives three years of full support followed by two of LTS.
- Build the image in the sandbox, then run the app or its tests inside it if you can. A clean build doesn't prove the app starts.
- Keep the runtime in the image in step with `engines`, `.nvmrc`, `.python-version` and CI; the runtime-eol notes cover that side.

**Common pitfalls.**

- Keeping the same OS when you could move it, or moving it when you didn't need to. Changing the runtime and the distro in one step makes failures harder to attribute, so name both choices in the PR.
- Bare tags. `node:26` follows whatever the publisher points it at today, and the default OS underneath can change. [Docker's advice](https://docs.docker.com/build/building/best-practices/) notes that tags are mutable and that a digest pin guarantees the same image, at the cost of no longer picking up fixes on its own. Follow the repo's existing convention unless the task calls for something else.
- `slim` and `alpine` variants drop tools the build relied on. Read `RUN` lines against what the new base provides.
- Forgetting the stage that isn't the final one: a build stage on an old image can still produce broken artifacts.
- Registries other than Docker Hub. Read their own lifecycle docs and say what you relied on.

**When you're unsure.** Pick the newest supported tag with the same OS family and variant, build what you can, and state plainly whether the image was built and run or only edited.
