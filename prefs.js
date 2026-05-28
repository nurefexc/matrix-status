import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

export default class MatrixStatusPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(640, 600);
        window.search_enabled = true;

        const page = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const apiGroup = new Adw.PreferencesGroup({
            title: 'Matrix API',
            description: 'Your homeserver address and account access token',
        });
        page.add(apiGroup);

        const homeserverRow = new Adw.EntryRow({
            title: 'Homeserver URL',
        });
        settings.bind('homeserver-url', homeserverRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        apiGroup.add(homeserverRow);

        const tokenRow = new Adw.PasswordEntryRow({
            title: 'Access Token',
        });
        settings.bind('access-token', tokenRow, 'text', Gio.SettingsBindFlags.DEFAULT);

        const tokenHelpIcon = new Gtk.Image({
            icon_name: 'help-about-symbolic',
            tooltip_text:
                'How to find your access token in Element Desktop:\n' +
                '1. Open Settings → Help & About (bottom-left)\n' +
                '2. Scroll to Advanced → Access Token\n' +
                '3. Click the copy button\n\n' +
                'Treat this like a password.',
            valign: Gtk.Align.CENTER,
        });
        tokenRow.add_suffix(tokenHelpIcon);
        apiGroup.add(tokenRow);

        const configGroup = new Adw.PreferencesGroup({
            title: 'General Settings',
        });
        page.add(configGroup);

        const intervalRow = new Adw.ActionRow({
            title: 'Sync Interval',
            subtitle: 'How often to poll for new messages (seconds)',
        });
        const intervalSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 3600,
                step_increment: 5,
                page_increment: 30,
            }),
            valign: Gtk.Align.CENTER,
            width_chars: 5,
        });
        settings.bind('sync-interval', intervalSpin, 'value', Gio.SettingsBindFlags.DEFAULT);
        intervalRow.add_suffix(intervalSpin);
        configGroup.add(intervalRow);

        const clientTypeRow = new Adw.ComboRow({
            title: 'Preferred Client',
            subtitle: 'Application to open when clicking a room',
        });
        const clientModel = new Gtk.StringList({
            strings: ['Web (matrix.to)', 'Element', 'Fractal', 'SchildiChat'],
        });
        clientTypeRow.model = clientModel;
        clientTypeRow.selected = Math.max(0, Math.min(settings.get_enum('client-type'), 3));
        clientTypeRow.connect('notify::selected', () => {
            settings.set_enum('client-type', clientTypeRow.selected);
        });
        configGroup.add(clientTypeRow);

        const notificationsRow = new Adw.ActionRow({
            title: 'Desktop Notifications',
            subtitle: 'Show GNOME Shell notifications for new messages',
        });
        const notificationsSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
        });
        settings.bind('notifications-enable', notificationsSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        notificationsRow.add_suffix(notificationsSwitch);
        notificationsRow.set_activatable_widget(notificationsSwitch);
        configGroup.add(notificationsRow);

        const qrRow = new Adw.ActionRow({
            title: 'QR Code Generation',
            subtitle: 'Add a QR button to rooms and your profile header',
        });
        const qrSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
        });
        settings.bind('generate-qr-code-enable', qrSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        qrRow.add_suffix(qrSwitch);
        qrRow.set_activatable_widget(qrSwitch);
        configGroup.add(qrRow);

        const linksGroup = new Adw.PreferencesGroup({
            title: 'Links & About',
        });
        page.add(linksGroup);

        const links = [
            {
                title: 'Source Code',
                subtitle: 'View the project on GitHub',
                label: 'GitHub',
                uri: 'https://github.com/nurefexc/matrix-status',
                accent: true,
            },
            {
                title: 'GitHub Profile',
                subtitle: 'Other projects by nurefexc',
                label: 'nurefexc',
                uri: 'https://github.com/nurefexc',
                accent: false,
            },
            {
                title: 'Personal Website',
                subtitle: 'nurefexc.com',
                label: 'Visit',
                uri: 'https://nurefexc.com',
                accent: false,
            },
        ];

        for (const link of links) {
            const row = new Adw.ActionRow({
                title: link.title,
                subtitle: link.subtitle,
                activatable: true,
            });

            const btn = new Gtk.Button({
                child: new Adw.ButtonContent({
                    icon_name: 'external-link-symbolic',
                    label: link.label,
                }),
                valign: Gtk.Align.CENTER,
                css_classes: link.accent ? ['suggested-action'] : [],
            });

            btn.connect('clicked', () => {
                Gio.AppInfo.launch_default_for_uri(link.uri, null);
            });

            row.add_suffix(btn);
            row.set_activatable_widget(btn);
            linksGroup.add(row);
        }
    }
}