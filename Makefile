export PATH			:=		$(PWD)/bin:$(PATH)
export INSIDE_STAGING_DIR	:=		false

# control-plane-ui excluded from build: pre-existing @scalar/openapi-types resolution issue
APPS := apps/control-plane apps/discovery apps/control-plane-stack apps/api-node-stack apps/database-stack apps/vpc-stack

all: lint build test

pre-build: FORCE
	rm -f .eslintcache .build-finished

build: pre-build $(APPS)
	touch .build-finished

lint:
	pnpm prettier -c .
	pnpm eslint --cache --ignore-pattern '**/.next/**' --ignore-pattern '**/next-env.d.ts' --ignore-pattern '**/postcss.config.mjs' .

test:
	pnpm -r run test

apps/%: FORCE
	cd $@ && pnpm tsc --noEmit

format:
	pnpm prettier -w .

clean:
	rm -f .env-checked .eslintcache .build-finished
	rm -rf .tap
	find . -type d -name "dist" -a ! -path '*/node_modules/*' | xargs rm -rf
	find . -type d -name ".tap" -a ! -path '*/node_modules/*' | xargs rm -rf

.env-checked: bin/check-env
	./bin/check-env
	touch .env-checked

include .env-checked

.PHONY: all lint test local-up local-down local-logs local-seed local-check local-flex-check local-reinstall local-restart local-ps local
local-up:
	docker compose up --build -d

local-down:
	docker compose down --volumes --remove-orphans

local-logs:
	docker compose logs -f

local-seed:
	docker compose run --rm seed-local-dev

local-check:
	docker compose run --rm local-check

local-flex-check:
	docker compose run --rm local-flex-check

local-reinstall:
	docker compose run --rm workspace-init

local-restart:
	docker compose up --build --force-recreate -d

local-ps:
	docker compose ps

local:
	@printf '%s\n' 'Use one of: make local-up, make local-down, make local-logs, make local-seed, make local-check, make local-flex-check'
FORCE:
