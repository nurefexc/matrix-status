/*
 * Matrix Status Monitor – Preferences UI
 *
 * Here we define the Adwaita (libadwaita) interface for editing
 * GSettings keys: homeserver, token, sync interval, client type.
 */
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

/**
 * Preferences window structure.
 * Layout:
 * 1) Matrix API (homeserver, access token)
 * 2) General settings (sync interval, client selector)
 * 3) Links/Info
 */
export default class MatrixStatusPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        // Matrix API Group
        const apiGroup = new Adw.PreferencesGroup({
            title: 'Matrix API Configuration',
            description: 'Enter your homeserver and access token',
        });
        page.add(apiGroup);

        const homeserverRow = new Adw.EntryRow({ title: 'Homeserver URL' });
        settings.bind('homeserver-url', homeserverRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        apiGroup.add(homeserverRow);

        const tokenRow = new Adw.PasswordEntryRow({ title: 'Access Token' });
        settings.bind('access-token', tokenRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        apiGroup.add(tokenRow);

        // Separator Group for visually dividing sections
        page.add(new Adw.PreferencesGroup());

        // Client Settings
        const configGroup = new Adw.PreferencesGroup({
            title: 'General Settings',
        });
        page.add(configGroup);

        const intervalRow = new Adw.ActionRow({
            title: 'Sync Interval (seconds)',
            subtitle: 'How often to check for new messages',
        });
        const intervalSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({ lower: 5, upper: 3600, step_increment: 5, page_increment: 10 }),
            valign: Gtk.Align.CENTER,
        });
        settings.bind('sync-interval', intervalSpin, 'value', Gio.SettingsBindFlags.DEFAULT);
        intervalRow.add_suffix(intervalSpin);
        configGroup.add(intervalRow);

        const clientTypeRow = new Adw.ComboRow({
            title: 'Preferred Client',
            subtitle: 'Choose which client to use when opening rooms',
        });

        const clientModel = new Gtk.StringList({
            strings: ['Web (matrix.to)', 'Element', 'Fractal'],
        });
        clientTypeRow.model = clientModel;

        clientTypeRow.selected = settings.get_enum('client-type');
        clientTypeRow.connect('notify::selected', () => {
            settings.set_enum('client-type', clientTypeRow.selected);
        });
        configGroup.add(clientTypeRow);

        // Separator Group
        page.add(new Adw.PreferencesGroup());

        // Project Links
        const linksGroup = new Adw.PreferencesGroup({ title: 'Links & About' });
        page.add(linksGroup);

        // GitHub Repository
        const repoRow = new Adw.ActionRow({
            title: 'Source Code',
            subtitle: 'View the project on GitHub',
        });

        const repoBtn = new Gtk.Button({
            child: new Adw.ButtonContent({
                icon_name: 'external-link-symbolic',
                label: 'GitHub',
            }),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });

        repoBtn.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri('https://github.com/nurefexc/matrix-status', null);
        });

        repoRow.add_suffix(repoBtn);
        linksGroup.add(repoRow);

        // GitHub Profile
        const profileRow = new Adw.ActionRow({
            title: 'GitHub Profile',
            subtitle: 'Check out my other projects',
        });

        const profileBtn = new Gtk.Button({
            child: new Adw.ButtonContent({
                icon_name: 'external-link-symbolic',
                label: 'nurefexc',
            }),
            valign: Gtk.Align.CENTER,
        });

        profileBtn.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri('https://github.com/nurefexc', null);
        });

        profileRow.add_suffix(profileBtn);
        linksGroup.add(profileRow);

        // Website
        const websiteRow = new Adw.ActionRow({
            title: 'Personal Website',
            subtitle: 'Visit nurefexc.com',
        });

        const websiteBtn = new Gtk.Button({
            child: new Adw.ButtonContent({
                icon_name: 'external-link-symbolic',
                label: 'nurefexc.com',
            }),
            valign: Gtk.Align.CENTER,
        });

        websiteBtn.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri('https://nurefexc.com', null);
        });

        websiteRow.add_suffix(websiteBtn);
        linksGroup.add(websiteRow);

        window.add(page);
    }
}