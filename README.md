# Collaborative Family Tree Application

A web-based family tree application that allows multiple users to collaboratively create and edit family trees in real-time. Built with family-chart library and Supabase.

## Features

- 🌳 **Interactive Family Tree Visualization** - Beautiful D3.js-powered family tree
- 👥 **Multi-User Collaboration** - Multiple users can edit the same tree simultaneously
- 🔄 **Real-time Sync** - Changes appear instantly for all users
- 🔐 **Access via Tree Code** - Share 6-character codes to grant access
- 💾 **Cloud Storage** - All data stored securely in Supabase
- 📱 **Responsive Design** - Works on desktop and mobile devices
- 💑 **Relationship Types** - Support for Married, Divorced, Partner, and Separated statuses

## Project Structure

```
family-tree-app/
├── index.html              # Landing page
├── tree.html               # Main tree interface
├── css/
│   ├── family-chart.css   # Family-chart styles
│   ├── landing.css        # Landing page styles
│   └── tree.css           # Tree page styles
├── js/
│   ├── config.js          # Supabase configuration
│   ├── supabase-client.js # Database operations
│   ├── landing.js         # Landing page logic
│   ├── tree-data.js       # Data transformation
│   ├── tree-main.js       # Main tree logic
│   └── tree-sync.js       # Real-time sync
└── README.md
```

## Setup Instructions

### 1. Set Up Supabase

1. Create a free account at [supabase.com](https://supabase.com)
2. Create a new project
3. Go to SQL Editor and run the database schema (see `database-schema.sql`)
4. Get your project credentials:
   - Go to Settings > API
   - Copy the "Project URL"
   - Copy the "anon public" API key

### 2. Configure the Application

1. Open `js/config.js`
2. Replace the placeholder values with your Supabase credentials:
   ```javascript
   export const SUPABASE_CONFIG = {
     url: 'https://your-project.supabase.co',
     anonKey: 'your-anon-key-here'
   }
   ```

### 3. Copy the CSS File

Copy the `family-chart.css` file from the provided files into the `css/` folder.

### 4. Deploy

You can deploy this application to any static hosting service:

- **GitHub Pages**: Push to GitHub and enable Pages
- **Netlify**: Drag and drop the folder
- **Vercel**: Deploy via CLI or GitHub integration
- **Local**: Use a simple HTTP server like `python -m http.server`

## Usage

### Creating a New Tree

1. Visit the landing page
2. Click "Create New Tree"
3. Enter a family tree name
4. You'll be redirected to the tree editor with a unique 6-character code

### Accessing an Existing Tree

1. Enter the 6-character tree code on the landing page
2. Click "View Tree"
3. Start collaborating!

### Editing the Tree

- **Click on a person** to edit their information
- **Add relatives** using the + button that appears when clicking a person
- **Delete a person** using the delete button in the edit form
- **Change the main person** by clicking on different people

### Sharing Access

Share the 6-character tree code with family members. Anyone with the code can:
- View the tree
- Add new family members
- Edit existing information
- Delete family members

## Data Fields

Each family member can have:
- First Name
- Last Name
- Year of Birth (YYYY format)
- Year of Death (YYYY format)
- Gender (M/F or unspecified)

## Relationship Types

**Parent-Child**: Automatically tracked
**Spousal Relationships**:
- **Married** (solid line)
- **Divorced** (red dashed line)
- **Partner** (dotted line)
- **Separated** (orange dashed line)

## Gender Color Coding

- 🔵 **Male**: Blue/Teal
- 🔴 **Female**: Pink/Rose
- ⚪ **Unspecified**: Light Gray

## Browser Compatibility

- Chrome/Edge (recommended)
- Firefox
- Safari
- Modern mobile browsers

## Security Notes

⚠️ **Important**: This application uses anonymous access for simplicity. Anyone with a tree code can edit the tree. For production use, consider:

- Implementing user authentication
- Adding access control levels (view-only, edit, admin)
- Implementing audit logs
- Adding rate limiting

## Troubleshooting

### Tree not loading
- Check browser console for errors
- Verify Supabase credentials in `config.js`
- Ensure database schema is correctly set up

### Real-time sync not working
- Check if Supabase Realtime is enabled in your project
- Verify Row Level Security policies are correctly set

### Tree code not found
- Verify the code is exactly 6 characters
- Check if the tree exists in the database

## Development

To run locally:
```bash
# Using Python
python -m http.server 8000

# Using Node.js http-server
npx http-server

# Using PHP
php -S localhost:8000
```

Then visit `http://localhost:8000`

## Credits

- **family-chart** library by donatso
- **D3.js** for visualization
- **Supabase** for backend and real-time sync

## License

ISC License - Free to use and modify

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review the family-chart documentation
3. Check Supabase documentation for database issues
