UUID = matrix-status@nurefexc.com
DEST = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all install compile clean restart lint

all: compile install

compile:
	@echo "Compiling schemas..."
	glib-compile-schemas schemas/

lint:
	@echo "Running linter..."
	npx eslint .

# Local installation (use with caution)
install: compile
	@echo "Installing extension to $(DEST)..."
	mkdir -p $(DEST)
	cp -r schemas icons extension.js prefs.js metadata.json stylesheet.css LICENSE README.md $(DEST)
	@echo "Installation complete."

# Create a zip for extensions.gnome.org
zip: compile
	@echo "Creating extension zip..."
	zip -r $(UUID).shell-extension.zip schemas icons extension.js prefs.js metadata.json stylesheet.css LICENSE README.md -x "schemas/gschemas.compiled"

restart:
	gnome-extensions disable $(UUID) || true
	gnome-extensions enable $(UUID)

clean:
	rm -rf $(DEST)